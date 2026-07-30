@echo off
setlocal EnableExtensions
node "%~dp0prepare-sidecar.mjs"
exit /b %ERRORLEVEL%
