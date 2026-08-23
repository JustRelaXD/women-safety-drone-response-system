# Run this from PowerShell inside e:\naira app\backend
# Usage:  cd "e:\naira app\backend"  ;  .\setup.ps1

Write-Host "Creating virtual environment at .venv ..."
python -m venv .venv

Write-Host "Activating virtual environment ..."
& .\.venv\Scripts\Activate.ps1

Write-Host "Upgrading pip ..."
python -m pip install --upgrade pip

Write-Host "Installing requirements ..."
pip install -r requirements.txt

Write-Host ""
Write-Host "Done. In VS Code, run 'Python: Select Interpreter' and choose:"
Write-Host "  e:\naira app\backend\.venv\Scripts\python.exe"
Write-Host "Then reload the window (Ctrl+Shift+P -> Developer: Reload Window)."
