# Builds a SYNTHETIC evaluation corpus with the Windows text-to-speech voices installed on this machine.
# Purpose: check that the evaluation pipeline works end to end. Synthetic speech is clean and uniform:
# it says nothing about real speakers, accents, noise or Wolof (no Windows voice exists for Wolof).
#
# Usage (from the repository root):  powershell -File scripts\make-synthetic-corpus.ps1
# Output: data\corpus\synthetic\ (git-ignored): one WAV per sentence, two silent clips, manifest.csv
# This file is ASCII on purpose: Windows PowerShell 5.1 misreads UTF-8 without a BOM. The sentences
# (with accents) live in synthetic_sentences.csv and are read with an explicit UTF-8 encoding.

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Speech

$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $root "data\corpus\synthetic"
New-Item -ItemType Directory -Force $out | Out-Null
$sentences = Import-Csv -Path (Join-Path $PSScriptRoot "synthetic_sentences.csv") -Encoding UTF8

$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$installed = $synth.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name }
$rows = @()

$ids = $sentences | ForEach-Object { $_.id }
if (($ids | Select-Object -Unique).Count -ne $ids.Count) { throw "synthetic_sentences.csv has duplicate ids." }
$position = @{ fr = 0; en = 0 }

foreach ($row in $sentences) {
    if ($row.id -notmatch '^[a-z]+-[0-9]+$') { throw "Invalid id '$($row.id)' (expected like fr-01)." }
    $voice = $installed | Where-Object { $_ -like "*$($row.voice)*" } | Select-Object -First 1
    if (-not $voice) { throw "Windows voice '$($row.voice)' is not installed." }
    $synth.SelectVoice($voice)
    $wav = Join-Path $out "$($row.id).wav"
    try {
        $synth.SetOutputToWaveFile($wav)
        $synth.Speak($row.reference)
    } finally {
        $synth.SetOutputToNull()   # always release the file, even when speaking failed
    }
    # Every 4th clip of each language goes to the validation split, so both splits get both languages.
    $position[$row.category] += 1
    $split = if (($position[$row.category] % 4) -eq 0) { "validation" } else { "dev" }
    $rows += [pscustomobject]@{
        id = $row.id; audio_path = "$($row.id).wav"; category = $row.category; reference = $row.reference
        split = $split; synthetic = 1; rights = "synthetic speech of project-authored text"
        speaker = $voice; context = "Windows SAPI voice, clean studio-like audio"
    }
}

# Two silent clips (16 kHz mono 16-bit, 3 s): hallucination probes, empty reference.
foreach ($n in 1, 2) {
    $path = Join-Path $out "silence-0$n.wav"
    $samples = 16000 * 3
    $stream = [System.IO.File]::Create($path)
    $writer = New-Object System.IO.BinaryWriter($stream)
    try {
        $writer.Write([System.Text.Encoding]::ASCII.GetBytes("RIFF")); $writer.Write([int](36 + $samples * 2))
        $writer.Write([System.Text.Encoding]::ASCII.GetBytes("WAVEfmt ")); $writer.Write([int]16)
        $writer.Write([int16]1); $writer.Write([int16]1); $writer.Write([int]16000); $writer.Write([int]32000)
        $writer.Write([int16]2); $writer.Write([int16]16)
        $writer.Write([System.Text.Encoding]::ASCII.GetBytes("data")); $writer.Write([int]($samples * 2))
        $writer.Write((New-Object byte[] ($samples * 2)))
    } finally {
        $writer.Close()
    }
    $rows += [pscustomobject]@{
        id = "silence-0$n"; audio_path = "silence-0$n.wav"; category = "silence"; reference = ""
        split = $(if ($n -eq 1) { "dev" } else { "validation" }); synthetic = 1
        rights = "generated digital silence"; speaker = ""; context = "3 s of zeros"
    }
}

$rows | Export-Csv -Path (Join-Path $out "manifest.csv") -NoTypeInformation -Encoding UTF8
Write-Output "Wrote $($rows.Count) clips to $out"
