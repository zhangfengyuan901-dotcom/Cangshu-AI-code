param([Parameter(Mandatory=$true)][string]$Source, [Parameter(Mandatory=$true)][string]$Output)
# Convert the supplied artwork to a multi-resolution Windows ICO without redrawing it.
Add-Type -AssemblyName System.Drawing
$sourceImage = [System.Drawing.Image]::FromFile((Resolve-Path -LiteralPath $Source).Path)
$iconImages = @()
try {
  foreach ($size in @(16,24,32,48,64,128,256)) {
    $bitmap = [System.Drawing.Bitmap]::new($size, $size)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $stream = [System.IO.MemoryStream]::new()
    try {
      $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $graphics.DrawImage($sourceImage, 0, 0, $size, $size)
      $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
      $iconImages += @{ Size=$size; Bytes=$stream.ToArray() }
    } finally { $graphics.Dispose(); $bitmap.Dispose(); $stream.Dispose() }
  }
  $targetStream = [System.IO.File]::Create([System.IO.Path]::GetFullPath($Output))
  $writer = [System.IO.BinaryWriter]::new($targetStream)
  try {
    $writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]$iconImages.Count)
    $offset = 6 + 16 * $iconImages.Count
    foreach ($entry in $iconImages) {
      $dimension = if ($entry.Size -eq 256) { 0 } else { $entry.Size }
      $writer.Write([byte]$dimension); $writer.Write([byte]$dimension)
      $writer.Write([byte]0); $writer.Write([byte]0)
      $writer.Write([uint16]1); $writer.Write([uint16]32)
      $writer.Write([uint32]$entry.Bytes.Length); $writer.Write([uint32]$offset)
      $offset += $entry.Bytes.Length
    }
    foreach ($entry in $iconImages) { $writer.Write([byte[]]$entry.Bytes) }
  } finally { $writer.Dispose(); $targetStream.Dispose() }
} finally { $sourceImage.Dispose() }
