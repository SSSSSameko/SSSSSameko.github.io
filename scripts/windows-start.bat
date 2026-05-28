@echo off
cd /d "%~dp0.."
if "%PORT%"=="" set PORT=4173
echo Starting Weibo Draw Studio on port %PORT%
echo CORS_ORIGINS=%CORS_ORIGINS%
node server.mjs
