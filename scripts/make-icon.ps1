# Draws assets/icon.ico (a speech bubble holding a sound wave) with the drawing tools built into Windows.
# The result is committed; run this only to change the icon.
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

function New-IconPng([int] $size) {
    $bitmap = New-Object System.Drawing.Bitmap $size, $size
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.Clear([System.Drawing.Color]::Transparent)

    $unit = $size / 256.0
    $accent = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 102, 113, 218))
    $graphics.FillEllipse($accent, 12 * $unit, 12 * $unit, 232 * $unit, 232 * $unit)

    # The sound wave: five rounded bars, widest contrast kept so it still reads at 16 pixels.
    $white = New-Object System.Drawing.Pen ([System.Drawing.Color]::White), (20 * $unit)
    $white.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $white.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $bars = @(@(64, 34), @(96, 62), @(128, 86), @(160, 62), @(192, 34))
    foreach ($bar in $bars) {
        $x = $bar[0] * $unit
        $half = $bar[1] * $unit
        $graphics.DrawLine($white, $x, (128 * $unit) - $half, $x, (128 * $unit) + $half)
    }
    $graphics.Dispose()

    $stream = New-Object System.IO.MemoryStream
    $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    $bitmap.Dispose()
    return ,$stream.ToArray()
}

$sizes = 16, 24, 32, 48, 64, 128, 256
$images = foreach ($size in $sizes) { ,(New-IconPng $size) }

$root = Split-Path -Parent $PSScriptRoot
$assets = Join-Path $root "assets"
New-Item -ItemType Directory -Force $assets | Out-Null
$output = [System.IO.File]::Create((Join-Path $assets "icon.ico"))
$writer = New-Object System.IO.BinaryWriter $output
# ICO header, one directory entry per size (0 means 256), then the PNG images.
$writer.Write([uint16] 0); $writer.Write([uint16] 1); $writer.Write([uint16] $sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
    $dimension = if ($sizes[$i] -ge 256) { 0 } else { $sizes[$i] }
    $writer.Write([byte] $dimension); $writer.Write([byte] $dimension)
    $writer.Write([byte] 0); $writer.Write([byte] 0)
    $writer.Write([uint16] 1); $writer.Write([uint16] 32)
    $writer.Write([uint32] $images[$i].Length); $writer.Write([uint32] $offset)
    $offset += $images[$i].Length
}
foreach ($image in $images) { $writer.Write([byte[]] $image) }
$writer.Dispose()
Write-Output "assets\icon.ico written."
