/**
 * server/segmentation.js
 * Recover which Inducks entry each scanned page belongs to.
 *
 * Inducks does not store a page-to-entry map: `inducks_entryurl.pagenumber` is
 * the literal string '1' on all 2 711 470 public rows. It does, however, encode
 * the information in `inducks_entry.position`: 'p012' means "this entry starts
 * on page 12". Sorting an issue's entries by that number and cutting at each
 * start reconstructs the exact page ranges — verified against the OCR, which
 * independently reads page 12 of fr/JMC 5 as « MON SOU FÉTICHE! » while Inducks
 * titles entry p012 "Sou fétiche de malheurs".
 *
 * Not every issue is segmentable. Spine collections use story subdivisions
 * instead of pages (fr/DDD 2: 'p009a', 'p010b' — the 'a'/'b' are continuations
 * of one story, not further pages). Those issues report why they were skipped
 * rather than guessing a split.
 */

/** Parsed shapes an Inducks `position` can take. */
const SHAPE = {
  LETTERED: 'lettered',   // a, b, c…           cover / editorial, in order
  PAGE: 'page',           // p012               starts on page 12
  SUBDIVISION: 'subdiv',  // p009a, p010b        a continuation of p009, NOT a page
  OTHER: 'other',         // anything else
};

/**
 * Classify one position value.
 * 'p009a' is a subdivision because it has trailing letters after the digits;
 * 'p009' is a page. Both start with 'p', so the digits alone are not enough.
 */
function parsePosition(position) {
  const pos = String(position || '').trim();
  if (/^[a-z]+$/i.test(pos)) return { shape: SHAPE.LETTERED, order: pos.toLowerCase() };
  const m = /^p(\d+)([a-z]*)$/i.exec(pos);
  if (m) {
    const page = parseInt(m[1], 10);
    const suffix = m[2].toLowerCase();
    return suffix
      ? { shape: SHAPE.SUBDIVISION, page, suffix }
      : { shape: SHAPE.PAGE, page };
  }
  return { shape: SHAPE.OTHER, raw: pos };
}

/**
 * Build the page ranges of one issue.
 *
 * @param entries  [{ entrycode, position, title }]
 * @param pageCount number of pages in the scanned archive
 * @returns { segments, shape, reason }
 *   segments: [{ entrycode, title, from, to }] with 1-based inclusive pages.
 */
function segmentIssue(entries, pageCount) {
  const parsed = entries.map((e) => ({ ...e, pos: parsePosition(e.position) }));

  const pages = parsed.filter((e) => e.pos.shape === SHAPE.PAGE).sort((a, b) => a.pos.page - b.pos.page);
  const lettered = parsed.filter((e) => e.pos.shape === SHAPE.LETTERED)
    .sort((a, b) => a.pos.order.localeCompare(b.pos.order));
  const subdivs = parsed.filter((e) => e.pos.shape === SHAPE.SUBDIVISION);

  if (!pages.length) {
    if (lettered.length && lettered.some((e) => e.entirepages)) {
      let curPage = 1;
      const segments = [];
      for (const e of lettered) {
        const length = parseInt(e.entirepages, 10) || 1;
        const from = curPage;
        const to = Math.min(pageCount, curPage + length - 1);
        segments.push({
          entrycode: e.entrycode,
          storycode: e.storycode || null,
          title: e.title || null,
          from,
          to,
          kind: e.kind || (e.title ? 'n' : 'other'),
        });
        curPage = to + 1;
        if (curPage > pageCount) break;
      }
      return { segments, shape: SHAPE.LETTERED };
    }

    return {
      segments: [],
      shape: subdivs.length ? SHAPE.SUBDIVISION : SHAPE.LETTERED,
      reason: subdivs.length
        ? 'entries are story subdivisions (p009a), not page numbers — the page ' +
          'boundaries are not in Inducks and would have to be detected in the scan'
        : 'no numeric page position in this issue',
    };
  }

  const segments = [];

  // Lettered positions come first in reading order and sit before the first
  // numbered page: 'a' is the cover or the editorial, not a story.
  if (lettered.length) {
    const firstPage = pages[0].pos.page;
    lettered.forEach((e, i) => {
      // They are consecutive leading pages; the last one runs up to firstPage-1.
      const from = i + 1;
      const to = i === lettered.length - 1 ? firstPage - 1 : null;
      segments.push({
        entrycode: e.entrycode,
        storycode: e.storycode || null,
        title: e.title || null,
        from,
        to: to && to >= from ? to : from,
        kind: 'editorial',
      });
    });
  }

  // Each numbered entry owns every page from its start to the next start - 1.
  pages.forEach((e, i) => {
    const from = e.pos.page;
    const to = i + 1 < pages.length ? pages[i + 1].pos.page - 1 : pageCount;
    segments.push({
      entrycode: e.entrycode,
      storycode: e.storycode || null,
      title: e.title || null,
      from,
      to: to >= from ? to : from,
      kind: 'story',
      // A subdivision of this same story shares its page range.
      alsoIncludes: parsed
        .filter((s) => s.pos.shape === SHAPE.SUBDIVISION && s.pos.page === from)
        .map((s) => ({ entrycode: s.entrycode, storycode: s.storycode || null, suffix: s.pos.suffix, title: s.title || null })),
    });
  });

  segments.sort((a, b) => a.from - b.from);
  return {
    segments,
    shape: SHAPE.PAGE,
    reason: subdivs.length
      ? `${subdivs.length} subdivision(s) attached to their parent story`
      : null,
  };
}

/**
 * Page -> entry lookup for one issue. Returns a Map(pageno -> segment).
 * Pages before the first lettered entry still resolve, because segments start at 1.
 */
function lookupByPage(segments) {
  const map = new Map();
  for (const s of segments) {
    for (let p = s.from; p <= s.to; p++) map.set(p, s);
  }
  return map;
}

module.exports = { SHAPE, parsePosition, segmentIssue, lookupByPage };