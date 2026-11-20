#!/usr/bin/env python
"""
server/ocr_worker.py — the one-pass OCR over the scan library.

Reads pending pages from the search database, runs PaddleOCR on each, writes the
text back. This is a background batch: it runs until the queue is empty, and a
page is only ever read once (the database is the durable record).

Model choice is deliberate. Measured on a real page of fr_JMC_1 (1810x2364):
  PP-OCRv5_mobile_det + latin_PP-OCRv5_mobile_rec  ->  45 s/page, mean conf 0.963
  PP-OCRv5_server_det                               -> ~180 s/page, same text
mobile is ~4x faster at the same accuracy here, so mobile is the default and
server is available for the occasional hard page.

Paddle 3.3.1 + PaddleOCR 3.5 crash in oneDNN ("ConvertPirAttribute2RuntimeAttribute"),
hence enable_mkldnn=False. KMP_DUPLICATE_LIB_OK is set by the caller because the
OpenMP runtime is loaded twice in this environment.

Usage:
  py -3.12 ocr_worker.py --limit 50            # OCR up to 50 pending pages
  py -3.12 ocr_worker.py --issue "fr/JMC   1"   # one issue
  py -3.12 ocr_worker.py --all                 # drain the queue
  py -3.12 ocr_worker.py --list                # what is pending
"""
import argparse
import errno
import gc
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import zipfile
from pathlib import Path
from PIL import Image

os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")
os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")
# Empêche Paddle de préallouer toute la VRAM du GPU (essentiel en multi-worker sur 4 Go)
os.environ.setdefault("FLAGS_allocator_strategy", "auto_growth")
os.environ.setdefault("FLAGS_fraction_of_gpu_memory_to_use", "0.45")
# Hard ceiling on what Paddle may allocate on the GPU. Without it, once the 4 GB
# card is full the Windows driver silently spills into system RAM (sysmem
# fallback) and the process takes all the machine's commit within seconds;
# with it, Paddle raises a GPU out-of-memory error that the supervisor handles.
os.environ.setdefault("FLAGS_gpu_memory_limit_mb", "3000")

# Enable CUDA / cuDNN third-party dynamic libraries (e.g. cudnn64_8.dll) on Windows
if sys.platform == "win32":
    try:
        torch_lib = Path(sys.executable).parent / "Lib" / "site-packages" / "torch" / "lib"
        if torch_lib.exists():
            os.add_dll_directory(str(torch_lib))
            os.environ["PATH"] = str(torch_lib) + os.pathsep + os.environ.get("PATH", "")
    except Exception:
        pass

# A PYTHONPATH pointing at another venv (an agent runtime, for instance) shadows
# Paddle's own pydantic and the pipeline dies on `No module named
# pydantic_core._pydantic_core`. This script installs its dependencies
# system-wide, so it needs nothing from an inherited path — and it has to go
# before the first `import paddleocr`, which is why this is a module-level pop
# rather than something done inside a function.
_inherited = os.environ.pop("PYTHONPATH", None)
if _inherited:
    # Drop exactly the entries PYTHONPATH contributed; anything else on sys.path
    # is this interpreter's own site-packages and must stay.
    for _entry in _inherited.split(os.pathsep):
        _entry = _entry.strip()
        if _entry and _entry in sys.path:
            sys.path.remove(_entry)

sys.path.insert(0, str(Path(__file__).resolve().parent))
import languages  # noqa: E402  (needs the path above)

# Only the scan images go off C:. Derived data stays with the app, under
# apps/transcript/data/; a full-library index is a couple of hundred MB of text,
# which is affordable next to the app. The unpacked pages go to the drive holding
# the library (SCAN_LIBRARY).
# SEARCH_DB / SCRATCH_DIR / INDUCKS_DB_DIR override.
DATA_DIR = Path(__file__).resolve().parent.parent / "data"
# The search database and the scratch directory come from the same central config
# as the Node side (server/config.js), which reads Archiving-Helper's
# TARGET_ARCHIVE_PATH / TRANSCRIPT_DB_DIR. Only the two directories are needed
# here, and they resolve as env -> Archiving-Helper's .env -> default, so the
# same three lines are repeated rather than spawning Node from Python to read a
# CommonJS module.
# Same derivation as config.js: parents[5] is Projets, Archiving-Helper lives in
# Projets/Automatisations. ARCHIVING_HELPER_ENV overrides both sides.
AH_ENV_CANDIDATES = [
    Path(os.environ["ARCHIVING_HELPER_ENV"]) if os.environ.get("ARCHIVING_HELPER_ENV") else None,
    Path(__file__).resolve().parents[5] / "Automatisations" / "Archiving-Helper" / "tools" / "download-files" / ".env",
    Path(__file__).resolve().parents[5] / "Automatisations" / "Archiving-Helper" / "download-files" / ".env",
]
AH_ENV = next((p for p in AH_ENV_CANDIDATES if p and p.exists()), AH_ENV_CANDIDATES[1])


def _config(key, fallback):
    """First non-empty value among process env, Archiving-Helper's .env, default."""
    for candidate in (os.environ.get(key),):
        if isinstance(candidate, str) and candidate.strip():
            return candidate.strip()
    try:
        for raw in AH_ENV.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            name, value = line.split("=", 1)
            if name.strip() == key:
                value = value.strip().strip('"').strip("'")
                if value:
                    return value
    except OSError:
        pass
    return fallback


INDUCKS_DB_DIR = Path(_config("TRANSCRIPT_DB_DIR", str(Path(__file__).resolve().parents[3] / "data" / "inducks-db")))
# Same rule as config.js (a test keeps them identical): the monorepo's data/inducks-db,
# never D:. D: holds scans only; defaulting to D:\inducks-db whenever it was plugged in
# sent the OCR to an old copy of the database while the API read the real one.
SEARCH_DB = Path(_config("SEARCH_DB", str(INDUCKS_DB_DIR / "search.sqlite")))
EXTRACT_DIR = Path(_config("SCRATCH_DIR", _config("TARGET_ARCHIVE_PATH", r"D:\Duckburg Archives\Disney comics")))

IMAGE_EXT = (".jpg", ".jpeg", ".png", ".gif", ".bmp", ".tif", ".tiff", ".webp")

# Reading order: how tall a horizontal band is, as a fraction of the page, before
# two balloons are considered to be on different rows. Measured on fr/JMC 5 p14:
# at 10% side-by-side balloons fall in the same row and read left to right, which
# matches how the page is drawn.
READ_ROW_FRACTION = float(os.environ.get("OCR_READ_ROW_FRACTION", 0.10))


# ─────────────────────────────────────────────────────────────────────────────
# Archive reading (.cbr via UnRAR, .cbz via the stdlib)
# ─────────────────────────────────────────────────────────────────────────────
UNRAR_CANDIDATES = [
    r"C:\Program Files\WinRAR\UnRAR.exe",
    r"C:\Program Files (x86)\WinRAR\UnRAR.exe",
]


def find_unrar():
    for p in UNRAR_CANDIDATES:
        if os.path.exists(p):
            return p
    return None


_TELDRIVE_CLIENT = None
_TELDRIVE_FILES = None


def get_teldrive_client():
    global _TELDRIVE_CLIENT
    if _TELDRIVE_CLIENT is None:
        try:
            ah_tools = Path(__file__).resolve().parents[5] / "Automatisations" / "Archiving-Helper" / "tools" / "teldrive-uploader"
            if ah_tools.exists() and str(ah_tools) not in sys.path:
                sys.path.insert(0, str(ah_tools))
            from teldrive_client import TelDriveClient
            _TELDRIVE_CLIENT = TelDriveClient()
        except Exception:
            pass
    return _TELDRIVE_CLIENT


def ensure_archive_from_teldrive(archive_str):
    """If archive is not accessible locally, download it directly from TelDrive."""
    local_p = Path(archive_str)
    if local_p.exists():
        return str(local_p)

    client = get_teldrive_client()
    if not client:
        raise FileNotFoundError(f"Local archive not found: {archive_str} (and TelDriveClient unavailable)")

    filename = local_p.name
    cached_path = Path(EXTRACT_DIR) / filename
    if cached_path.exists() and cached_path.stat().st_size > 0:
        return str(cached_path)

    global _TELDRIVE_FILES
    if _TELDRIVE_FILES is None:
        print("[teldrive] Indexing scan library from TelDrive...", flush=True)
        _TELDRIVE_FILES = client.files_by_path()

    matched_item = None
    for remote_path, item in _TELDRIVE_FILES.items():
        if item.get("name") == filename or remote_path.endswith(f"/{filename}"):
            matched_item = item
            break

    if not matched_item:
        raise FileNotFoundError(f"Archive '{filename}' not found locally or in TelDrive")

    print(f"[teldrive] Downloading {filename} via TelDrive API...", flush=True)
    os.makedirs(str(EXTRACT_DIR), exist_ok=True)
    client.download_to(matched_item["id"], filename, cached_path)
    return str(cached_path)


# The whole archive is read through the TelDrive mount: allow ample time for Telegram
# bot throttle and Blitz proxy latency (at least 5 min for a 100 MB tome).
EXTRACT_BASE_S = 180
EXTRACT_MIN_MB_PER_S = 0.5


def extract_timeout_s(size_bytes):
    """Seconds allowed to extract an archive of `size_bytes` from the library."""
    return EXTRACT_BASE_S + (size_bytes / 1e6) / EXTRACT_MIN_MB_PER_S


def _storage_responds(path, timeout=20):
    """True if the first bytes of `path` can be read within `timeout` seconds.

    A dead network mount does not fail fast: reads hang until rclone gives up, so
    the probe runs in a daemon thread and a hang counts as "not responding".
    """
    import threading
    result = {}

    def probe():
        try:
            with open(path, "rb") as f:
                result["ok"] = bool(f.read(65536))
        except OSError:
            result["ok"] = False

    t = threading.Thread(target=probe, daemon=True)
    t.start()
    t.join(timeout)
    return result.get("ok", False)


# Windows statuses meaning "the machine could not give this process resources",
# not "this archive is bad": STATUS_DLL_INIT_FAILED (a child cannot even start when
# commit is exhausted) and ERROR_COMMITMENT_LIMIT / pagefile too small.
_RESOURCE_EXIT_CODES = {0xC0000142}
_RESOURCE_WINERRORS = {1455}


def _is_resource_failure(error):
    """True if `error` comes from the machine being out of memory, not from the file.

    194 pages of two healthy archives were marked failed in six seconds because
    UnRAR could not start (0xC0000142) while another program held the memory."""
    if isinstance(error, MemoryError):
        return True
    if isinstance(error, subprocess.CalledProcessError):
        return (error.returncode & 0xFFFFFFFF) in _RESOURCE_EXIT_CODES
    return getattr(error, "winerror", None) in _RESOURCE_WINERRORS


_STORAGE_WINERRORS = {
    1117,  # ERROR_IO_DEVICE ("erreur de périphérique d'E/S")
    121,   # ERROR_SEM_TIMEOUT
    64,    # ERROR_NETNAME_DELETED
    53,    # ERROR_BAD_NETPATH
    59,    # ERROR_UNEXP_NET_ERR
}


def _is_storage_failure(error, archive_path=None):
    """True if error is a storage or network glitch (rclone/TelDrive disconnect, I/O device error)."""
    if isinstance(error, subprocess.TimeoutExpired):
        return True
    if getattr(error, "winerror", None) in _STORAGE_WINERRORS:
        return True
    if isinstance(error, OSError) and getattr(error, "errno", None) in (errno.EIO, errno.ETIMEDOUT, errno.ECONNRESET):
        return True
    if isinstance(error, subprocess.CalledProcessError):
        output = f"{error.output or ''} {error.stderr or ''}".lower()
        if any(term in output for term in (
            "périphérique d'e/s", "peripherique d'e/s", "i/o", "device", "erreur de périphérique", "non disponible", "occupé"
        )):
            return True
        if archive_path and str(archive_path).lower().startswith(("t:", "z:", "\\\\")):
            if not _storage_responds(archive_path, timeout=5):
                return True
    return False


def _extract_to(archive_path, dest_dir):
    """Unpack an issue archive into dest_dir."""
    archive_path = ensure_archive_from_teldrive(archive_path)
    p = Path(archive_path)
    ext = p.suffix.lower()
    dest_dir = Path(dest_dir)
    dest_dir.mkdir(parents=True, exist_ok=True)

    if ext in (".cbr", ".rar"):
        unrar = find_unrar()
        if not unrar:
            raise RuntimeError("UnRAR.exe not found (install WinRAR) — .cbr cannot be read")
        res = subprocess.run(
            [unrar, "e", "-p-", "-o+", "-idq", "-y", str(archive_path)],
            cwd=str(dest_dir),
            capture_output=True, text=True,
            input="", timeout=extract_timeout_s(p.stat().st_size),
        )
        if res.returncode != 0:
            raise subprocess.CalledProcessError(res.returncode, res.args, output=res.stdout, stderr=res.stderr)
    else:
        with zipfile.ZipFile(archive_path) as z:
            for member in z.namelist():
                if member.lower().endswith(('.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tif', '.tiff')):
                    data = z.read(member)
                    (dest_dir / Path(member).name).write_bytes(data)


class IssueExtractor:
    """Manages batch extraction and background prefetching of issue archives.

    Extracts an issue into a local scratch folder in ONE operation.
    Subsequent page accesses are instant local SSD reads (0 ms).
    Prefetches the NEXT issue in a background thread while the GPU processes the current issue,
    eliminating idle transition times between issues.
    """

    def __init__(self, scratch_dir):
        self.scratch_dir = Path(scratch_dir)
        self.scratch_dir.mkdir(parents=True, exist_ok=True)
        self.current_archive = None
        self.archive_dir = None
        self._lock = threading.Lock()
        self.prefetch_thread = None
        self.prefetched_archive = None
        self.prefetched_dir = None
        self.prefetch_error = None
        self.failed_archive = None
        self.failed_error = None

    def cleanup(self):
        with self._lock:
            if self.archive_dir and self.archive_dir.exists():
                try:
                    shutil.rmtree(self.archive_dir, ignore_errors=True)
                except Exception:
                    pass
            if self.prefetched_dir and self.prefetched_dir.exists():
                try:
                    shutil.rmtree(self.prefetched_dir, ignore_errors=True)
                except Exception:
                    pass
            self.current_archive = None
            self.archive_dir = None
            self.prefetched_archive = None
            self.prefetched_dir = None
            self.prefetch_error = None
            self.prefetch_thread = None

    def trigger_prefetch(self, next_archive_path):
        """Asynchronously unpack the next archive in background while OCR runs."""
        if not next_archive_path:
            return
        next_archive_str = str(next_archive_path)
        with self._lock:
            if next_archive_str == self.current_archive:
                return
            if next_archive_str == self.prefetched_archive and self.prefetch_thread:
                return  # already in progress or completed

            # Clean previous completed prefetch directory if not used
            if self.prefetch_thread and not self.prefetch_thread.is_alive() and self.prefetched_dir:
                try:
                    shutil.rmtree(self.prefetched_dir, ignore_errors=True)
                except Exception:
                    pass

            base_archive = Path(next_archive_path).name
            safe_name = "".join(c if c.isalnum() or c in ("-", "_") else "_" for c in base_archive)
            target_dir = self.scratch_dir / f"prefetch_{safe_name}"
            target_dir.mkdir(parents=True, exist_ok=True)

            self.prefetched_archive = next_archive_str
            self.prefetched_dir = target_dir
            self.prefetch_error = None

            def _bg_task():
                t0 = time.time()
                try:
                    _extract_to(next_archive_str, target_dir)
                    dt = time.time() - t0
                    print(f"  [prefetch] Ready in background: {base_archive} ({dt:.1f}s)", flush=True)
                except Exception as ex:
                    self.prefetch_error = ex

            self.prefetch_thread = threading.Thread(target=_bg_task, daemon=True)
            self.prefetch_thread.start()
            print(f"  [prefetch] Pre-extracting next issue: {base_archive}...", flush=True)

    def get_page(self, archive_path, pagename):
        archive_str = str(archive_path)
        base_archive = Path(archive_path).name
        target_name = Path(pagename).name

        if self.failed_archive == archive_str:
            raise self.failed_error

        # If switching to a new archive
        if self.current_archive != archive_str:
            self.failed_archive = None
            self.failed_error = None
            # Check if it was prefetched in background
            if self.prefetched_archive == archive_str and self.prefetch_thread:
                t0 = time.time()
                self.prefetch_thread.join()
                wait_time = time.time() - t0
                if self.prefetch_error:
                    err = self.prefetch_error
                    self.failed_archive = archive_str
                    self.failed_error = err
                    self.cleanup()
                    raise err
                # Clean up old archive directory
                if self.archive_dir and self.archive_dir.exists():
                    try:
                        shutil.rmtree(self.archive_dir, ignore_errors=True)
                    except Exception:
                        pass
                self.current_archive = archive_str
                self.archive_dir = self.prefetched_dir
                self.prefetched_archive = None
                self.prefetched_dir = None
                self.prefetch_thread = None
                if wait_time > 0.1:
                    print(f"  [prefetch] Switched to {base_archive} (waited {wait_time:.1f}s)", flush=True)
                else:
                    print(f"  [prefetch] Instant switch to {base_archive} (0 ms wait, already ready!)", flush=True)
            else:
                # Direct fallback (synchronous)
                if self.archive_dir and self.archive_dir.exists():
                    try:
                        shutil.rmtree(self.archive_dir, ignore_errors=True)
                    except Exception:
                        pass
                safe_name = "".join(c if c.isalnum() or c in ("-", "_") else "_" for c in base_archive)
                self.archive_dir = self.scratch_dir / f"extracted_{safe_name}"
                self.archive_dir.mkdir(parents=True, exist_ok=True)
                try:
                    _extract_to(archive_str, self.archive_dir)
                    self.current_archive = archive_str
                except Exception as ex:
                    self.failed_archive = archive_str
                    self.failed_error = ex
                    self.cleanup()
                    raise

        # Look for target file in self.archive_dir
        dest = self.archive_dir / target_name
        if not dest.exists():
            lower_target = target_name.lower()
            for f in self.archive_dir.iterdir():
                if f.name.lower() == lower_target:
                    dest = f
                    break

        if not dest.exists():
            raise FileNotFoundError(f"Page '{target_name}' not found in unpacked archive {base_archive}")

        return str(dest)


def extract_page(archive, pagename, dest_dir):
    """Legacy single-page extraction helper."""
    extractor = IssueExtractor(dest_dir)
    return extractor.get_page(archive, pagename)


# ─────────────────────────────────────────────────────────────────────────────
# OCR
# ─────────────────────────────────────────────────────────────────────────────
def _lang_for_rec(rec_model, default_lang="latin"):
    if not rec_model:
        return default_lang
    name = str(rec_model).lower()
    for prefix in ("latin", "cyrillic", "arabic", "japan", "korean", "devanagari", "ch", "chinese_cht", "el", "ta", "te", "th"):
        if name.startswith(prefix):
            return prefix
    return default_lang


def build_ocr(detector, rec_model=None, rec_batch_num=8):
    """Build a PaddleOCR pipeline for one detector + recogniser model.

    Recreating the pipeline per page would pay the model load every time, so the
    caller keeps one instance per (detector, recogniser) pair in _OCR_CACHE.
    """
    key = (detector, rec_model, rec_batch_num)
    if key in _OCR_CACHE:
        return _OCR_CACHE[key]

    import paddle
    from paddleocr import PaddleOCR

    use_cuda = paddle.is_compiled_with_cuda()
    if use_cuda:
        try:
            paddle.device.set_device('gpu')
        except Exception:
            pass

    # Support both PaddleOCR 2.x and PaddleOCR 3.x
    if hasattr(PaddleOCR, "ocr") and not hasattr(PaddleOCR, "predict"):
        lang = _lang_for_rec(rec_model, "latin")
        ocr = PaddleOCR(use_angle_cls=False, lang=lang, use_gpu=use_cuda, show_log=False, rec_batch_num=rec_batch_num)
    else:
        cfg = {"text_detection_model_name": f"PP-OCRv5_{detector}_det"}
        if rec_model:
            cfg["text_recognition_model_name"] = rec_model
        if use_cuda:
            cfg["device"] = "gpu"
        cfg["rec_batch_num"] = rec_batch_num
        ocr = PaddleOCR(enable_mkldnn=False, use_angle_cls=False, **cfg)

    _OCR_CACHE[key] = ocr
    return ocr


_OCR_CACHE = {}

# Exit code used when the GPU context is poisoned (CUDA OOM cascade).
# The caller (PowerShell loop or systemd) should restart on this code.
EXIT_CODE_GPU_OOM = 75
# The supervisor killed a worker that stopped giving signs of life (see run_watched).
EXIT_CODE_STALLED = 76

# Watchdog. A read on the TelDrive mount can block for tens of minutes: the worker sat
# alive, 1 thread, 0 % GPU and unkillable from 10:40 until the read came back, and the
# OCR "stopped" with nothing in any log. The worker touches a heartbeat file at every
# page and every wait (all shorter than a minute); silence for STALL_S means stuck.
# 30 min stays above the longest legitimate step (a 1 GB archive extracts in < 18 min).
STALL_S = int(_config("OCR_STALL_S", "1800"))
_HEARTBEAT = os.environ.get("OCR_HEARTBEAT_FILE")


def beat():
    """Tell the supervisor this worker is alive (no-op when not supervised)."""
    if _HEARTBEAT:
        try:
            Path(_HEARTBEAT).touch()
        except OSError:
            pass


def remount_library():
    """Remount T: through Archiving-Helper: the only way to release a read stuck in rclone."""
    script = AH_ENV.parent.parent / "mount-drive" / "mount_drive.py"
    if not script.exists():
        print(f"  cannot remount: {script} not found", flush=True)
        return
    subprocess.run([sys.executable, str(script), "remount"], timeout=600,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def run_watched(child, stall_s=None, poll_s=30, kill_wait_s=120, unstick=remount_library, heartbeat=None):
    """subprocess.call(child), with a watchdog on the child's heartbeat.

    A silent child is killed and EXIT_CODE_STALLED returned. If it does not die (an
    I/O stuck in the mount keeps a process alive past TerminateProcess), the library
    is remounted to release it."""
    stall_s = STALL_S if stall_s is None else stall_s
    hb = Path(heartbeat or Path(tempfile.gettempdir()) / f"transcript_ocr_{os.getpid()}.heartbeat")
    hb.touch()
    proc = subprocess.Popen(child, env={**os.environ, "OCR_HEARTBEAT_FILE": str(hb)})
    try:
        while True:
            try:
                return proc.wait(timeout=poll_s)
            except subprocess.TimeoutExpired:
                pass
            silent = time.time() - hb.stat().st_mtime
            if silent < stall_s:
                continue
            print(f"[{time.strftime('%H:%M:%S')}] worker silent for {silent / 60:.0f} min "
                  f"(stuck reading the library?) - killing it", flush=True)
            proc.kill()
            try:
                proc.wait(timeout=kill_wait_s)
            except subprocess.TimeoutExpired:
                print(f"[{time.strftime('%H:%M:%S')}] worker does not die: an I/O on the library is "
                      f"stuck - remounting it", flush=True)
                unstick()
                try:
                    proc.wait(timeout=kill_wait_s)
                except subprocess.TimeoutExpired:
                    print("  still stuck - starting a new worker anyway", flush=True)
            return EXIT_CODE_STALLED
    finally:
        try:
            hb.unlink()
        except OSError:
            pass

# A worker that dies sooner than this did not crash mid-run: it never started.
MIN_RUN_BEFORE_RESTART_S = 60


def should_restart(rc, ran_seconds):
    """Whether the supervisor relaunches a worker that exited with `rc`.

    75 = memory exhausted, handled by the worker, and 76 = killed by the watchdog
    after going silent: always restart. Any other failure
    after a real run is a native crash at the memory cap: restart. A failure within
    the first minute is a setup error (missing database, broken install) that a
    restart would only repeat, and a clean exit means the queue is done.
    """
    if rc in (EXIT_CODE_GPU_OOM, EXIT_CODE_STALLED):
        return True
    return rc != 0 and ran_seconds >= MIN_RUN_BEFORE_RESTART_S


def supervise(child, call=run_watched, wait=None, now=time.time, sleep=time.sleep):
    """Run the worker command `child` until it ends for good; return its exit code.

    Before every launch, wait for room for a whole worker (its cap) on top of the
    reserve left to other programs: a worker loading its models allocates up to its
    cap, and launching it with only the reserve free made it die on its first page
    and restart every ~40 s, squeezing the other programs each time."""
    wait = wait or wait_for_free_commit
    while True:
        wait(MIN_FREE_COMMIT_MB + MEMORY_LIMIT_MB)
        started = now()
        rc = call(child)
        if not should_restart(rc, now() - started):
            return rc
        print(f"[{time.strftime('%H:%M:%S')}] worker restarted (exit {rc})", flush=True)
        sleep(3)

# Ceiling on the worker's own committed memory (MB). One page in a few hundred
# makes Paddle jump by ~2.5 GB of system RAM; without a cap that spike takes the
# whole machine's commit and other programs fail to start. With it, the spike
# becomes a MemoryError in this process only, which restarts the worker.
# The job object counts what CUDA commits for the GPU too (up to
# FLAGS_gpu_memory_limit_mb), which PrivatePageCount does not show: measured peak
# 2.7 GB of process memory + ~3 GB GPU. At 3800 every text-heavy page (50+ lines)
# "ran out of GPU memory"; at 6000 all 49 pages of be/HBIV 1977 read (up to 88 lines).
MEMORY_LIMIT_MB = int(_config("OCR_MEMORY_LIMIT_MB", "6000"))

# Machine-wide commit the worker leaves to other programs (MB). The archiving
# pipeline runs on the same machine; when the OCR took the last of the commit, the
# pipeline failed with MemoryError on every volume. Below this, the worker waits.
MIN_FREE_COMMIT_MB = int(_config("OCR_MIN_FREE_COMMIT_MB", "2000"))


def free_commit_mb():
    """Commit still available on the whole machine (MB), or None off Windows."""
    if sys.platform != "win32":
        return None
    import ctypes

    class MemoryStatusEx(ctypes.Structure):
        _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                    ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                    ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                    ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                    ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]

    status = MemoryStatusEx()
    status.dwLength = ctypes.sizeof(status)
    if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
        return None
    return status.ullAvailPageFile // (1024 * 1024)


def wait_for_free_commit(minimum_mb, label="", poll_s=30, free=free_commit_mb, sleep=time.sleep):
    """Block while the machine has less than `minimum_mb` of commit left.

    Returns the number of waits, so a caller (or a test) can tell it paused."""
    waits = 0
    while True:
        available = free()
        if available is None or available >= minimum_mb:
            return waits
        if waits == 0:
            print(f"  {label}[{time.strftime('%H:%M:%S')}] only {available} MB of memory left on the "
                  f"machine (< {minimum_mb}) - OCR paused so other programs keep running", flush=True)
        waits += 1
        beat()
        sleep(poll_s)


def _cap_own_memory(limit_mb):
    """Put this process in a Windows job object limited to `limit_mb` of commit."""
    if sys.platform != "win32" or limit_mb <= 0:
        return
    import ctypes
    from ctypes import wintypes

    class IoCounters(ctypes.Structure):
        _fields_ = [(n, ctypes.c_ulonglong) for n in (
            "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
            "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]

    class BasicLimits(ctypes.Structure):
        _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64),
                    ("PerJobUserTimeLimit", ctypes.c_int64),
                    ("LimitFlags", wintypes.DWORD),
                    ("MinimumWorkingSetSize", ctypes.c_size_t),
                    ("MaximumWorkingSetSize", ctypes.c_size_t),
                    ("ActiveProcessLimit", wintypes.DWORD),
                    ("Affinity", ctypes.c_size_t),
                    ("PriorityClass", wintypes.DWORD),
                    ("SchedulingClass", wintypes.DWORD)]

    class ExtendedLimits(ctypes.Structure):
        _fields_ = [("BasicLimitInformation", BasicLimits),
                    ("IoInfo", IoCounters),
                    ("ProcessMemoryLimit", ctypes.c_size_t),
                    ("JobMemoryLimit", ctypes.c_size_t),
                    ("PeakProcessMemoryUsed", ctypes.c_size_t),
                    ("PeakJobMemoryUsed", ctypes.c_size_t)]

    JOB_OBJECT_LIMIT_PROCESS_MEMORY = 0x100
    JobObjectExtendedLimitInformation = 9
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    k32.CreateJobObjectW.restype = wintypes.HANDLE
    k32.GetCurrentProcess.restype = wintypes.HANDLE
    k32.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int,
                                            ctypes.c_void_p, wintypes.DWORD]
    k32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    job = k32.CreateJobObjectW(None, None)
    info = ExtendedLimits()
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_PROCESS_MEMORY
    info.ProcessMemoryLimit = limit_mb * 1024 * 1024
    ok = (job and k32.SetInformationJobObject(job, JobObjectExtendedLimitInformation,
                                              ctypes.byref(info), ctypes.sizeof(info))
          and k32.AssignProcessToJobObject(job, k32.GetCurrentProcess()))
    if not ok:
        print(f"  ! memory cap not applied (error {ctypes.get_last_error()})", flush=True)


def _is_cuda_oom(error):
    """True if the error is a CUDA / cuDNN out-of-memory failure."""
    msg = str(error)
    return any(k in msg for k in (
        "ResourceExhaustedError", "CUDNN_STATUS_ALLOC_FAILED",
        "Out of memory error on GPU", "Unable to allocate",
    ))


def _group_balloons(lines):
    """Rebuild balloons from the OCR lines, then read them in order.

    PaddleOCR detects one box per *line of text*, not per balloon, so a single
    bubble arrives split: "ACCUEIL DE" / "L'AEROPORT" / "LE PROCHAIN VOL" /
    "POUR ZOIVILLE?" are four boxes of one balloon. Joining them in detection
    order produced the unreadable wall of fragments this replaces.

    Two steps, both on the boxes PaddleOCR already returns (dt_polys):
      1. group lines into balloons — lines of one bubble share a column, so they
         overlap horizontally and sit within about a line height of each other;
      2. read the balloons top to bottom, and left to right within a row.

    On fr/JMC 5 page 14 this turns 29 lines into 13 balloons, which is what a
    reader sees on the page.
    """
    groups = []
    for b in sorted(lines, key=lambda b: (b["x0"], b["y0"])):
        placed = False
        for g in groups:
            overlap = min(b["x1"], g["x1"]) - max(b["x0"], g["x0"])
            narrow = min(b["x1"] - b["x0"], g["x1"] - g["x0"])
            gap = max(0.0, max(b["y0"], g["y0"]) - min(b["y1"], g["y1"]))
            line_h = min(b["y1"] - b["y0"], g["y1"] - g["y0"])
            if overlap > 0.6 * narrow and gap < 1.6 * line_h:
                g["lines"].append(b)
                g["x0"] = min(g["x0"], b["x0"])
                g["x1"] = max(g["x1"], b["x1"])
                g["y0"] = min(g["y0"], b["y0"])
                g["y1"] = max(g["y1"], b["y1"])
                placed = True
                break
        if not placed:
            groups.append({"lines": [b], "x0": b["x0"], "x1": b["x1"],
                           "y0": b["y0"], "y1": b["y1"]})

    for g in groups:
        g["lines"].sort(key=lambda b: b["y0"])
        g["text"] = " ".join(l["text"] for l in g["lines"])

    # Rows: balloons at a similar height read left to right, as on the page.
    if groups:
        height = max(g["y1"] for g in groups)
        row_h = max(height * READ_ROW_FRACTION, 1.0)
        groups.sort(key=lambda g: (round(((g["y0"] + g["y1"]) / 2) / row_h), g["x0"]))
    return groups


def ocr_page(ocr, image_path, max_dim_cap=960):
    """Run OCR on one page (supporting both PaddleOCR 2.x and 3.x).

    Returns (text, mean_confidence, n_boxes, ms, width, height) where text holds
    one balloon per line, in reading order.
    max_dim_cap: maximum pixel dimension before downscaling (default 960 for 4 GB VRAM safety).
    """
    t0 = time.time()
    w = h = None
    target_path = str(image_path)
    temp_downscaled = None

    # On a 4 GB VRAM GPU (RTX 3050 Ti), the detector's conv2d_transpose saturates
    # VRAM on images above ~1280px.  In multi-worker mode the budget is halved,
    # so the cap must be tighter.  The value is set by the caller via max_dim_cap
    # (default 960 for safety) and passed through ocr_page's signature.
    try:
        with Image.open(image_path) as im:
            im.verify()
        with Image.open(image_path) as im:
            w, h = im.size
            max_dim = max(w, h)
            if max_dim > max_dim_cap:
                scale = max_dim_cap / max_dim
                new_w, new_h = int(w * scale), int(h * scale)
                resample = getattr(Image, "Resampling", Image).BILINEAR
                im_resized = im.resize((new_w, new_h), resample=resample)
                temp_downscaled = Path(image_path).parent / f"opt_{Path(image_path).name}"
                im_resized.save(str(temp_downscaled), "JPEG", quality=90)
                target_path = str(temp_downscaled)
    except Exception as e:
        raise RuntimeError(f"Cannot read image file {image_path}: {e}")

    lines = []
    try:
        if hasattr(ocr, "ocr"):
            raw_res = ocr.ocr(target_path, cls=False)
            box_list = raw_res[0] if raw_res and len(raw_res) > 0 and raw_res[0] else []
            for item in box_list:
                if not item or len(item) < 2:
                    continue
                box, (t, score) = item
                t = (t or "").strip()
                if not t:
                    continue
                xs = [float(pt[0]) for pt in box]
                ys = [float(pt[1]) for pt in box]
                lines.append({
                    "text": t,
                    "score": float(score),
                    "x0": min(xs), "x1": max(xs), "y0": min(ys), "y1": max(ys),
                })
        elif hasattr(ocr, "predict"):
            result = ocr.predict(target_path)
            r = result[0]
            texts = r.get("rec_texts") or []
            scores = r.get("rec_scores") or []
            polys = r.get("dt_polys")
            if polys is None:
                polys = r.get("rec_polys")
            for i, raw in enumerate(texts):
                t = (raw or "").strip()
                if not t or polys is None or i >= len(polys):
                    continue
                xs = [float(v) for v in polys[i][:, 0]]
                ys = [float(v) for v in polys[i][:, 1]]
                lines.append({
                    "text": t,
                    "score": float(scores[i]) if i < len(scores) else 0.0,
                    "x0": min(xs), "x1": max(xs), "y0": min(ys), "y1": max(ys),
                })
    finally:
        if temp_downscaled and temp_downscaled.exists():
            try:
                temp_downscaled.unlink()
            except Exception:
                pass

    if lines:
        groups = _group_balloons(lines)
        text = "\n".join(g["text"] for g in groups)
        mean = sum(l["score"] for l in lines) / len(lines)
    else:
        text, mean = "", 0.0

    return text, mean, len(lines), int((time.time() - t0) * 1000), w, h


# ─────────────────────────────────────────────────────────────────────────────
# Database
# ─────────────────────────────────────────────────────────────────────────────
def ensure_fts_healthy(db):
    """Put the FTS index in a state where incremental writes are safe.

    Two distinct faults produce "database disk image is malformed" on write,
    both invisible to `PRAGMA integrity_check` and to FTS 'integrity-check':

    1. The index was created but never populated — `page_fts_idx` and
       `page_fts_docsize` are empty while `page_fts_data` holds rows.
    2. After that, any UPDATE on the *content* table followed by a DELETE on the
       index reproduces the error, deterministically. A 'rebuild' regenerates the
       index from the content table and makes the update/delete/insert cycle
       reliable; the content is external so this is cheap.
    """
    try:
        data = db.execute("SELECT COUNT(*) FROM page_fts_data").fetchone()[0]
        idx = db.execute("SELECT COUNT(*) FROM page_fts_idx").fetchone()[0]
    except sqlite3.DatabaseError:
        pass
    else:
        if not (idx == 0 and data > 0):
            return "ok"
    try:
        db.execute("INSERT INTO page_fts(page_fts) VALUES('rebuild')")
        return "rebuilt"
    except sqlite3.DatabaseError:
        return "rebuild-failed"


def connect():
    db = sqlite3.connect(SEARCH_DB, timeout=60, isolation_level=None)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA journal_mode = WAL")
    db.execute("PRAGMA synchronous = NORMAL")
    db.execute("PRAGMA cache_size = -64000")
    db.execute("PRAGMA temp_store = MEMORY")
    # No wal_checkpoint() here. It makes the first DELETE succeed but leaves the
    # index in a state where the next write fails with "database disk image is
    # malformed". The Node server and the indexer are separate processes on this
    # file; the busy timeout is what resolves them.
    db.execute("PRAGMA busy_timeout = 60000")
    # Schema check for pipeline_version and structured_text
    cols = [r["name"] for r in db.execute("PRAGMA table_info(page)").fetchall()]
    if "pipeline_version" not in cols:
        db.execute("ALTER TABLE page ADD COLUMN pipeline_version INTEGER NOT NULL DEFAULT 1")
    if "structured_text" not in cols:
        db.execute("ALTER TABLE page ADD COLUMN structured_text TEXT")
    return db


def fts_count(db, floor=0.80):
    """Pages actually present in the FTS index.

    COUNT(*) on an external-content FTS5 table returns the size of the *content*
    table, not the number of indexed rows — every page would look indexed even
    before any OCR ran. There is no row count on an external-content index, so the
    honest figure is the same predicate that decides indexing, applied to `page`.
    """
    return db.execute(
        """SELECT COUNT(*) FROM page
           WHERE state = 'done' AND text IS NOT NULL AND TRIM(text) <> '' AND confidence >= ?""",
        (floor,),
    ).fetchone()[0]


# Inducks storyversion kinds ('n', 'k') and segmentation.js's 'story'.
STORY_KINDS = ("n", "k", "story")


def story_page_sql():
    """SQL predicate for "this page belongs to a story" — mirror of storyPageSql() in
    searchdb.js (a test keeps STORY_KINDS identical on both sides)."""
    kinds = ", ".join(f"'{k}'" for k in STORY_KINDS)
    return f"(kind IN ({kinds}) OR (COALESCE(kind, '') = '' AND title IS NOT NULL))"


def pending_pages(db, limit, issuecode=None, country=None, max_issues=None, stories_only=False, worker_id=0, num_workers=1, reprocess=False):
    """Pending pages, in scan order, optionally filtered."""
    where = ["state = 'done' AND (pipeline_version IS NULL OR pipeline_version < 2)"] if reprocess else ["state = 'pending'"]
    if stories_only:
        where.append(story_page_sql())
    params = []
    if issuecode:
        where.append("REPLACE(issuecode, ' ', '') = ?")
        params.append(issuecode.replace(" ", ""))
    if country:
        where.append("country = ?")
        params.append(country)
    clause = " AND ".join(where)

    # Restrict to assigned issues if running in multi-worker mode
    if num_workers > 1:
        import zlib
        issue_rows = db.execute(
            f"SELECT DISTINCT issuecode FROM page WHERE {clause} ORDER BY issuecode"
        ).fetchall()
        assigned_issues = [
            r[0] for r in issue_rows
            if (zlib.crc32(r[0].encode("utf-8")) % num_workers) == worker_id
        ]
        if not assigned_issues:
            return []
        clause += f" AND issuecode IN ({','.join('?' * len(assigned_issues))})"
        params.extend(assigned_issues)

    if max_issues:
        issues = db.execute(
            f"""SELECT DISTINCT issuecode FROM page
                WHERE {clause} ORDER BY issuecode LIMIT ?""",
            (*params, max_issues),
        ).fetchall()
        if not issues:
            return []
        names = [r[0] for r in issues]
        clause += f" AND issuecode IN ({','.join('?' * len(names))})"
        params.extend(names)

    sql = f"SELECT * FROM page WHERE {clause} ORDER BY issuecode, pageno LIMIT ?"
    return db.execute(sql, (*params, limit)).fetchall()


def _fts_write(db, page_id, text, conf, floor):
    """Write one page's text into the FTS index, recovering if the index is stale.

    With an external-content FTS5 table, an UPDATE on the content table followed
    by a DELETE on the index can fail with "database disk image is malformed"
    while every integrity check reads clean. A 'rebuild' regenerates the index
    from the content table and makes the write go through, so this retries once
    after a rebuild rather than losing the page.

    A page below the confidence floor is deliberately left out of the index: it
    would put words in the results that the scan does not contain.
    """
    indexed = bool(text.strip()) and conf >= floor
    for attempt in (0, 1):
        try:
            db.execute("DELETE FROM page_fts WHERE rowid = ?", (page_id,))
            if indexed:
                db.execute("INSERT INTO page_fts (rowid, text) VALUES (?, ?)", (page_id, text))
            return indexed
        except sqlite3.DatabaseError:
            if attempt:
                raise
            db.execute("INSERT INTO page_fts(page_fts) VALUES('rebuild')")


def store(db, page_id, text, conf, n_boxes, ms, w, h, engine, floor, pipeline_version=1, structured_text=None):
    """Write the OCR result and index it only if it is confident enough."""
    row = db.execute("SELECT reviewed FROM page WHERE id = ?", (page_id,)).fetchone()
    if row is None:
        return
    db.execute(
        """UPDATE page SET text = ?, confidence = ?, n_boxes = ?, ocr_engine = ?, ocr_ms = ?,
                           width = ?, height = ?, pipeline_version = ?, structured_text = ?,
                           state = 'done', error = NULL, updated_at = unixepoch()
           WHERE id = ?""",
        (text, conf, n_boxes, engine, ms, w, h, pipeline_version, structured_text, page_id),
    )
    if row["reviewed"]:
        # A human already corrected this page; the OCR must not overwrite it.
        return
    _fts_write(db, page_id, text, conf, floor)


def fail(db, page_id, error):
    db.execute(
        "UPDATE page SET state = 'failed', error = ?, updated_at = unixepoch() WHERE id = ?",
        (str(error)[:500], page_id),
    )


# A page that exhausts memory this many times in a row is given up on: without a
# limit the worker restarted on the same page forever and the queue never moved.
OOM_ATTEMPTS_PER_PAGE = 2
_OOM_MARK = "oom-attempts:"


def record_oom(db, page_id, error, machine_short=False):
    """Count one memory exhaustion on a page. Returns True when the page is given up.

    The count lives in page.error while the page stays pending, so it survives the
    worker restart that follows; a later success clears it (store() resets error).
    When the whole machine was short of memory (`machine_short`), the page is not
    to blame: it stays pending and its count is left untouched. Counting those
    gave up perfectly normal pages every other page while another program ran."""
    if machine_short:
        return False
    row = db.execute("SELECT error FROM page WHERE id = ?", (page_id,)).fetchone()
    previous = row[0] if row else None
    attempts = 1
    if previous and previous.startswith(_OOM_MARK):
        attempts = int(previous[len(_OOM_MARK):].split()[0]) + 1
    if attempts >= OOM_ATTEMPTS_PER_PAGE:
        fail(db, page_id, f"memory exhausted on {attempts} attempts: {str(error).strip()[:300]}")
        return True
    db.execute("UPDATE page SET error = ?, updated_at = unixepoch() WHERE id = ?",
               (f"{_OOM_MARK}{attempts}", page_id))
    return False


# ─────────────────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=20, help="pages to OCR this run")
    ap.add_argument("--issue", default=None, help="restrict to one issuecode")
    ap.add_argument("--all", action="store_true", help="drain the queue (--limit ignored)")
    ap.add_argument("--country", default=None,
                    help="restrict to one country (matches page.country)")
    ap.add_argument("--max-issues", type=int, default=None,
                    help="stop after this many issues, for a batch that ends cleanly")
    ap.add_argument("--list", action="store_true", help="show queue state and exit")
    ap.add_argument("--detector", default="mobile", choices=["mobile", "server"])
    ap.add_argument("--floor", type=float, default=None, help="min confidence to index")
    ap.add_argument("--continuous", action="store_true", help="run continuously, polling for new pages")
    # Every page is read by default: the search must find a word wherever it is printed
    # (covers, editorials, games, and issues Inducks cannot segment). Stories first is
    # an opt-in for a quicker partial pass.
    ap.add_argument("--stories-only", dest="stories_only", action="store_true", default=False,
                    help="only OCR pages belonging to stories (default: every page)")
    ap.add_argument("--all-pages", dest="stories_only", action="store_false",
                    help="OCR every page (the default; kept for existing scripts)")
    ap.add_argument("--worker-id", type=int, default=0, help="Worker ID (0-based) for parallel execution")
    ap.add_argument("--num-workers", type=int, default=1, help="Total number of parallel workers")
    ap.add_argument("--rec-batch-num", type=int, default=None,
                    help="Batch size for recognition (default: 8 in multi-worker, 16 in single worker)")
    ap.add_argument("--reprocess-list", action="store_true",
                    help="show issues that need a v2 pipeline repass and exit")
    ap.add_argument("--reprocess", action="store_true",
                    help="process pages that already have state='done' but pipeline_version < 2")
    ap.add_argument("--no-supervise", action="store_true",
                    help="internal: run the OCR loop in this process (set by the supervisor)")
    args = ap.parse_args()

    # Paddle's memory use grows with every new page shape until an allocation
    # fails, every few hundred pages here. The worker then exits (or is stopped by
    # its memory cap); with --continuous or --all this process only supervises a
    # child and restarts it, so a long run needs no external loop.
    if (args.continuous or args.all) and not args.no_supervise:
        child = [sys.executable, os.path.abspath(__file__), *sys.argv[1:], "--no-supervise"]
        sys.exit(supervise(child))

    if args.no_supervise:
        _cap_own_memory(MEMORY_LIMIT_MB)

    if not SEARCH_DB.exists():
        sys.exit(f"search database not found: {SEARCH_DB}\nRun: node scripts/index-library.js first")

    db = connect()

    floor = args.floor if args.floor is not None else float(
            os.environ.get("OCR_CONFIDENCE_FLOOR", 0.80)
        )

    if args.list:
        rows = db.execute(
            """SELECT issuecode, country, COUNT(*) AS pages,
                      SUM(state = 'done') AS done, SUM(state = 'pending') AS pending
               FROM page GROUP BY issuecode ORDER BY issuecode"""
        ).fetchall()
        total = db.execute("SELECT COUNT(*) FROM page").fetchone()[0]
        done = db.execute("SELECT COUNT(*) FROM page WHERE state='done'").fetchone()[0]
        indexed = fts_count(db)
        print(f"pages: {total}  done: {done}  indexed: {indexed}  issues: {len(rows)}")
        for r in rows[:40]:
            print(f"  {r['issuecode']:<16} {r['country'] or '?':<6} "
                  f"{r['pages']:>4} pages  done={r['done']}  pending={r['pending']}")
        if len(rows) > 40:
            print(f"  … and {len(rows) - 40} more issues")
        return

    if args.reprocess_list:
        rows = db.execute(
            """SELECT issuecode, country, COUNT(*) AS pages,
                      SUM(state = 'done') AS done,
                      SUM(state = 'done' AND (pipeline_version IS NULL OR pipeline_version < 2)) AS pending_repass
               FROM page GROUP BY issuecode
               HAVING pending_repass > 0
               ORDER BY issuecode"""
        ).fetchall()
        total_repass = sum(r["pending_repass"] for r in rows)
        total_done = db.execute("SELECT COUNT(*) FROM page WHERE state='done'").fetchone()[0]
        print(f"Repass needed: {total_repass} pages across {len(rows)} issues (sur {total_done} pages terminées)")
        for r in rows[:40]:
            print(f"  {r['issuecode']:<16} {r['country'] or '?':<6} "
                  f"{r['pending_repass']:>4} pages à repasser (sur {r['done']} traitées)")
        if len(rows) > 40:
            print(f"  … et {len(rows) - 40} autres numéros")
        return

    # 8 lines per recognition batch, whatever the worker count: at 16 a text-heavy page
    # (be/HBIV 1977 p7, 51 lines, 4 700 chars) overflows the 4 GB GPU, while 8 reads it
    # with the same text and confidence (0.961 vs 0.962 at 4). Measured, not guessed.
    rec_batch = args.rec_batch_num if args.rec_batch_num is not None else 8
    t_start = time.time()
    ok = failed = skipped = indexed = 0
    cur_model = None
    ocr = None
    worker_label = f"[w{args.worker_id}/{args.num_workers}] " if args.num_workers > 1 else ""
    extractor = IssueExtractor(EXTRACT_DIR / f"worker_{args.worker_id}")

    try:
        while True:
            limit = 50 if args.continuous else (-1 if args.all else args.limit)
            pages = pending_pages(
                db, limit, args.issue, country=args.country,
                max_issues=args.max_issues, stories_only=args.stories_only,
                worker_id=args.worker_id, num_workers=args.num_workers,
                reprocess=args.reprocess
            )
            beat()
            if not pages:
                if args.continuous:
                    time.sleep(10)
                    continue
                print(f"{worker_label}nothing pending — the OCR pass is complete for this selection")
                break

            print(f"{worker_label}OCR batch of {len(pages)} page(s) with PP-OCRv5_{args.detector}_det (floor {floor:.2f})", flush=True)
            health = ensure_fts_healthy(db)
            if health == "rebuilt":
                print(f"  {worker_label}FTS index was inconsistent - rebuilt", flush=True)

            for i, p in enumerate(pages, 1):
                label = f"{p['issuecode']} p{p['pageno']}"
                beat()
                wait_for_free_commit(MIN_FREE_COMMIT_MB, worker_label)

                # The recogniser follows the issue's language, so it matches the script.
                # The model is only rebuilt when the language actually changes, which
                # keeps a multi-country run from reloading it on every page.
                lang = p["languagecode"]
                model = languages.model_for(lang)
                if model != cur_model:
                    try:
                        ocr = build_ocr(args.detector, model, rec_batch_num=rec_batch)
                        cur_model = model
                    except Exception as e:
                        print(f"  {worker_label}! cannot load {model}: {e}", flush=True)
                        failed += len(pages) - i
                        break
                    if not languages.is_supported(lang):
                        print(f"  {worker_label}recogniser: {model} (no model for '{lang}' - these pages "
                              f"will likely fall below the floor)", flush=True)
                    else:
                        print(f"  {worker_label}recogniser: {model} ({lang or 'unknown'})", flush=True)

                try:
                    img = extractor.get_page(p["archive"], p["pagename"])
                except Exception as e:
                    if not _storage_responds(p["archive"]):
                        # The library is a network mount (rclone/teldrive): when its
                        # server drops, every page would fail the same way and the
                        # queue would be burnt. Leave it pending and retry later.
                        print(f"  {worker_label}[{time.strftime('%H:%M:%S')}] storage not responding "
                              f"({label}) - page left pending, retrying in 60 s", flush=True)
                        db.commit()
                        time.sleep(60)
                        break
                    if isinstance(e, subprocess.TimeoutExpired):
                        # Even at the low throughput allowed, the mount did not deliver:
                        # the storage is slow, not the archive bad. Leave it pending.
                        print(f"  {worker_label}[{time.strftime('%H:%M:%S')}] {label}: storage too slow "
                              f"(extraction > {e.timeout:.0f} s) - page left pending, retrying in 60 s", flush=True)
                        db.commit()
                        time.sleep(60)
                        break
                    if _is_storage_failure(e, p["archive"]):
                        print(f"  {worker_label}[{time.strftime('%H:%M:%S')}] {label}: storage I/O error "
                              f"({e}) - page left pending, retrying in 60 s", flush=True)
                        db.commit()
                        time.sleep(60)
                        break
                    available = free_commit_mb()
                    if _is_resource_failure(e) or (available is not None and available < MIN_FREE_COMMIT_MB):
                        # Not the archive's fault: leave every page pending and wait.
                        print(f"  {worker_label}[{time.strftime('%H:%M:%S')}] {label}: extraction failed "
                              f"for lack of memory - page left pending", flush=True)
                        db.commit()
                        wait_for_free_commit(MIN_FREE_COMMIT_MB, worker_label)
                        break
                    print(f"  {worker_label}[{i}/{len(pages)}] {label}: EXTRACT FAILED {e} (skipping remaining pages of this issue)")
                    db.execute("UPDATE page SET state = 'failed', error = ? WHERE archive = ? AND state = 'pending'", (f"extract: {e}", p["archive"]))
                    db.commit()
                    break

                # Anticipate and prefetch the next issue in background while GPU is processing pages
                if not extractor.prefetched_archive:
                    next_archive = None
                    for future_p in pages[i:]:
                        if future_p["archive"] != p["archive"]:
                            next_archive = future_p["archive"]
                            break
                    if not next_archive:
                        try:
                            next_row = db.execute(
                                "SELECT archive FROM page WHERE state = 'pending' AND archive != ? ORDER BY issuecode, pageno LIMIT 1",
                                (p["archive"],)
                            ).fetchone()
                            if next_row:
                                next_archive = next_row["archive"]
                        except Exception:
                            pass
                    if next_archive:
                        extractor.trigger_prefetch(next_archive)

                try:
                    text, conf, n, ms, w, h = ocr_page(ocr, img)
                except Exception as e:
                    if _is_cuda_oom(e):
                        # Once memory is exhausted every later page fails the same way:
                        # restart the process with fresh memory instead of failing the
                        # queue. A page that does it repeatedly is given up on alone.
                        available = free_commit_mb()
                        machine_short = available is not None and available < MIN_FREE_COMMIT_MB
                        gave_up = record_oom(db, p["id"], e, machine_short)
                        db.commit()
                        verdict = ("given up (too large)" if gave_up
                                   else "left pending (machine short of memory)" if machine_short
                                   else "left pending")
                        print(f"  {worker_label}[{i}/{len(pages)}] {label}: memory exhausted "
                              f"- page {verdict}, restarting", flush=True)
                        extractor.cleanup()
                        os._exit(EXIT_CODE_GPU_OOM)
                    print(f"  {worker_label}[{i}/{len(pages)}] {label}: OCR FAILED {e}")
                    gc.collect()
                    try:
                        import paddle
                        if hasattr(paddle.device.cuda, "empty_cache"):
                            paddle.device.cuda.empty_cache()
                    except Exception:
                        pass
                    fail(db, p["id"], f"ocr: {e}")
                    db.commit()
                    failed += 1
                    continue

                will_index = bool(text.strip()) and conf >= floor
                store(db, p["id"], text, conf, n, ms, w, h, f"paddle-{args.detector}", floor)
                ok += 1
                indexed += 1 if will_index else 0
                flag = "" if will_index else "  (below floor, not indexed)"
                print(f"  {worker_label}[{i}/{len(pages)}] {label}: {n} boxes, conf {conf:.3f}, {ms/1000:.1f}s{flag}", flush=True)

                # Commit in batches of 10 pages and collect memory
                if i % 10 == 0 or i == len(pages):
                    db.commit()
                    gc.collect()
                    try:
                        import paddle
                        if hasattr(paddle.device.cuda, "empty_cache"):
                            paddle.device.cuda.empty_cache()
                    except Exception:
                        pass

            if not args.continuous and not args.all:
                break
    finally:
        extractor.cleanup()

    # One optimize at the end keeps the index compact; queries are unaffected.
    try:
        db.execute("INSERT INTO page_fts(page_fts) VALUES('optimize')")
        db.commit()
    except sqlite3.Error:
        pass

    elapsed = time.time() - t_start
    print(f"\ndone: {ok} OCR'd, {indexed} indexed, {failed} failed, {skipped} skipped "
          f"in {elapsed/60:.1f} min")
    if ok:
        print(f"  ~{elapsed/ok:.0f}s/page average")
    remaining = db.execute("SELECT COUNT(*) FROM page WHERE state='pending'").fetchone()[0]
    print(f"  {remaining} page(s) still pending")


if __name__ == "__main__":
    main()