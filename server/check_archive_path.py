from ocr_worker import connect
db = connect()
row = db.execute("SELECT DISTINCT archive FROM page WHERE issuecode='br/AD    4'").fetchone()
print("Stored archive path:", row[0] if row else "None")

