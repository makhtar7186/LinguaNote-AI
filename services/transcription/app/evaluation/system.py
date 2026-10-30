"""Environment facts recorded with every evaluation run, and peak-memory measurement."""
import ctypes
import os
import platform
import subprocess
import sys
from ctypes import wintypes
from importlib import metadata

TRACKED_PACKAGES = ("faster-whisper", "ctranslate2", "av", "onnxruntime", "numpy")


def peak_memory_bytes() -> int | None:
    """Peak resident memory of this process, or None where it cannot be read."""
    if sys.platform == "win32":
        class Counters(ctypes.Structure):
            _fields_ = [
                ("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD),
                ("PeakWorkingSetSize", ctypes.c_size_t), ("WorkingSetSize", ctypes.c_size_t),
                ("QuotaPeakPagedPoolUsage", ctypes.c_size_t), ("QuotaPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t), ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                ("PagefileUsage", ctypes.c_size_t), ("PeakPagefileUsage", ctypes.c_size_t),
            ]

        counters = Counters()
        counters.cb = ctypes.sizeof(Counters)
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        psapi = ctypes.WinDLL("psapi", use_last_error=True)
        kernel32.GetCurrentProcess.restype = wintypes.HANDLE
        psapi.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(Counters), wintypes.DWORD]
        if psapi.GetProcessMemoryInfo(kernel32.GetCurrentProcess(), ctypes.byref(counters), counters.cb):
            return int(counters.PeakWorkingSetSize)
        return None
    try:
        import resource
        peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        return int(peak * (1 if sys.platform == "darwin" else 1024))
    except (ImportError, OSError):
        return None


def _version(package: str) -> str | None:
    try:
        return metadata.version(package)
    except metadata.PackageNotFoundError:
        return None


def ffmpeg_version(ffmpeg: str) -> str | None:
    try:
        output = subprocess.run([ffmpeg, "-version"], capture_output=True, text=True, timeout=10, check=True)
    except (OSError, subprocess.SubprocessError):
        return None
    return output.stdout.splitlines()[0] if output.stdout else None


def environment_facts(ffmpeg: str) -> dict:
    return {
        "python": platform.python_version(),
        "platform": platform.platform(),
        "processor": platform.processor(),
        "logical_cpus": os.cpu_count(),
        "cpu_threads_setting": os.getenv("LINGUANOTE_CPU_THREADS", "4"),
        "packages": {name: _version(name) for name in TRACKED_PACKAGES},
        "ffmpeg": ffmpeg_version(ffmpeg),
    }
