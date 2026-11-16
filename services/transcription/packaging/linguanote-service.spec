# PyInstaller recipe of the local service. Run through scripts/build-installer.ps1.
# A folder build, not a single file: a single file unpacks itself to %TEMP% at every launch, which is slow with these
# native libraries and makes the service look like what antivirus software dislikes.
from pathlib import Path

from PyInstaller.utils.hooks import collect_all, collect_submodules

SERVICE_DIR = Path(SPECPATH).parent

datas, binaries, hiddenimports = [], [], []
# Native libraries and data files found by no static analysis: the Silero VAD model of faster_whisper, the DLLs of
# ctranslate2, onnxruntime and PyAV.
for package in ("faster_whisper", "ctranslate2", "onnxruntime", "av", "tokenizers"):
    package_datas, package_binaries, package_imports = collect_all(package)
    datas += package_datas
    binaries += package_binaries
    hiddenimports += package_imports
# uvicorn picks its protocol and loop implementations by name at run time.
hiddenimports += collect_submodules("uvicorn")

analysis = Analysis(
    [str(Path(SPECPATH) / "service_entry.py")],
    pathex=[str(SERVICE_DIR)],
    datas=datas,
    binaries=binaries,
    hiddenimports=hiddenimports,
    # Development tools and optional features the service never loads when it is installed: the MCP server, the
    # evaluation tooling and the experimental Omnilingual engine stay available from the sources only.
    excludes=["pytest", "ruff", "mcp", "sympy", "mpmath", "omnilingual_asr", "tkinter", "matplotlib", "IPython",
              "app.mcp_server", "app.evaluation"],
)
pyz = PYZ(analysis.pure)
executable = EXE(
    pyz,
    analysis.scripts,
    [],
    exclude_binaries=True,
    name="linguanote-service",
    # A console program: its errors reach the launcher through stderr. The launcher starts it with windowsHide, so no
    # window ever appears.
    console=True,
    upx=False,
)
COLLECT(executable, analysis.binaries, analysis.datas, name="linguanote-service", upx=False)
