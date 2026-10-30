"""Command line: python -m app.evaluation {run,report} ...

`run` evaluates one or several models over a manifest. Every model runs in its own process so that the
peak-memory figure belongs to that model alone. No model is downloaded unless --allow-download is given.
"""
import argparse
import json
import os
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

from app.config import load_settings
from app.engines.registry import create_engine
from app.evaluation.manifest import ManifestError, load_manifest
from app.evaluation.runner import evaluate_item, render_markdown, result_to_dict
from app.evaluation.system import environment_facts, peak_memory_bytes

MODEL_ENV = {"faster-whisper": "LINGUANOTE_WHISPER_MODEL", "omnilingual-ctc": "LINGUANOTE_MODEL_CARD"}
DEFAULT_OUT = Path(__file__).resolve().parents[4] / "data" / "eval-results"  # repository data/ (git-ignored)


def _single(args: argparse.Namespace) -> int:
    if not args.allow_download:
        os.environ["HF_HUB_OFFLINE"] = "1"  # a missing local model fails instead of downloading silently
    os.environ[MODEL_ENV[args.engine]] = args.model
    settings = load_settings()
    items = load_manifest(Path(args.manifest), split=args.split)

    started = time.perf_counter()
    engine = create_engine(args.engine)
    load_seconds = time.perf_counter() - started

    results = []
    for index, item in enumerate(items, start=1):
        print(f"[{args.model}] {index}/{len(items)} {item.id}", flush=True)
        results.append(result_to_dict(evaluate_item(engine, item, ffmpeg=settings.ffmpeg)))

    payload = {
        "meta": {
            "engine": args.engine, "model": args.model, "split": args.split,
            "device": "cpu", "compute_type": "int8", "manifest": str(Path(args.manifest).name),
            "load_seconds": load_seconds, "peak_memory_bytes": peak_memory_bytes(),
            "date": datetime.now().isoformat(timespec="seconds"),
            "environment": environment_facts(settings.ffmpeg),
        },
        "items": results,
    }
    Path(args.out_json).write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
    return 0


def _run(args: argparse.Namespace) -> int:
    try:
        items = load_manifest(Path(args.manifest), split=args.split)
    except ManifestError as exc:
        print(f"Invalid manifest:\n{exc}", file=sys.stderr)
        return 2
    if not items:
        print("The manifest has no clip for this split.", file=sys.stderr)
        return 2

    out = Path(args.out) if args.out else DEFAULT_OUT / datetime.now().strftime("%Y%m%d-%H%M%S")
    out.mkdir(parents=True, exist_ok=True)
    runs = []
    for model in [m.strip() for m in args.models.split(",") if m.strip()]:
        target = out / f"{args.engine}-{model}.json"
        command = [
            sys.executable, "-m", "app.evaluation", "_single", "--manifest", args.manifest,
            "--engine", args.engine, "--model", model, "--out-json", str(target),
        ]
        if args.split:
            command += ["--split", args.split]
        if args.allow_download:
            command.append("--allow-download")
        if subprocess.run(command, check=False).returncode != 0:
            print(f"Model '{model}' failed (not cached? add --allow-download after reviewing the model).",
                  file=sys.stderr)
            return 1
        runs.append(json.loads(target.read_text(encoding="utf-8")))

    report = render_markdown(runs)
    (out / "report.md").write_text(report, encoding="utf-8")
    print(f"\n{report}\nResults: {out}")
    return 0


def _report(args: argparse.Namespace) -> int:
    runs = [json.loads(Path(path).read_text(encoding="utf-8")) for path in args.inputs]
    print(render_markdown(runs))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m app.evaluation", description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)

    run = commands.add_parser("run", help="evaluate models over a manifest")
    run.add_argument("--manifest", required=True)
    run.add_argument("--models", required=True, help="comma-separated, e.g. tiny,base,small")
    run.add_argument("--engine", default="faster-whisper", choices=sorted(MODEL_ENV))
    run.add_argument("--split", choices=("dev", "validation"), help="evaluate one split only")
    run.add_argument("--out", help="output directory (default: data/eval-results/<timestamp>)")
    run.add_argument("--allow-download", action="store_true", help="permit fetching missing model weights")
    run.set_defaults(handler=_run)

    single = commands.add_parser("_single")  # internal: one model in its own process
    single.add_argument("--manifest", required=True)
    single.add_argument("--engine", required=True)
    single.add_argument("--model", required=True)
    single.add_argument("--split")
    single.add_argument("--out-json", required=True)
    single.add_argument("--allow-download", action="store_true")
    single.set_defaults(handler=_single)

    report = commands.add_parser("report", help="render saved result files as markdown")
    report.add_argument("inputs", nargs="+")
    report.set_defaults(handler=_report)

    args = parser.parse_args(argv)
    return args.handler(args)


if __name__ == "__main__":
    raise SystemExit(main())
