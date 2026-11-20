@echo off
rem Transcript, cote PC : montage T:, API locale (+ envoi vers l'API publique), OCR.
rem Details : apps\transcript\README.md, section « Lancer ».
cd /d "%~dp0server"
node scripts\start.js
pause
