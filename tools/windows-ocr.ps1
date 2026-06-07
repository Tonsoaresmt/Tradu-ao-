param(
  [Parameter(Mandatory = $true)]
  [string] $ImagePath
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Runtime.WindowsRuntime

$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Media.Ocr, ContentType = WindowsRuntime]

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() |
  Where-Object {
    $_.Name -eq "AsTask" -and
    $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]

function Await-WinRt($Operation, [type] $ResultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
  $task = $asTask.Invoke($null, @($Operation))
  $task.Wait() | Out-Null
  $task.Result
}

function Normalize-Rect($Rect, [double] $Width, [double] $Height) {
  @{
    x = [Math]::Max(0.0, [Math]::Min(1.0, $Rect.X / $Width))
    y = [Math]::Max(0.0, [Math]::Min(1.0, $Rect.Y / $Height))
    width = [Math]::Max(0.01, [Math]::Min(1.0, $Rect.Width / $Width))
    height = [Math]::Max(0.01, [Math]::Min(1.0, $Rect.Height / $Height))
  }
}

$resolvedPath = (Resolve-Path -LiteralPath $ImagePath).Path
$file = Await-WinRt ([Windows.Storage.StorageFile]::GetFileFromPathAsync($resolvedPath)) ([Windows.Storage.StorageFile])
$stream = Await-WinRt ($file.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
$decoder = Await-WinRt ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await-WinRt ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()

if ($null -eq $engine) {
  throw "Windows OCR nao esta disponivel para os idiomas do perfil do usuario."
}

$result = Await-WinRt ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
$imageWidth = [double] $bitmap.PixelWidth
$imageHeight = [double] $bitmap.PixelHeight
$lines = New-Object System.Collections.Generic.List[object]

foreach ($line in $result.Lines) {
  $words = @($line.Words)
  if ($words.Count -eq 0) {
    continue
  }

  $left = ($words | ForEach-Object { $_.BoundingRect.X } | Measure-Object -Minimum).Minimum
  $top = ($words | ForEach-Object { $_.BoundingRect.Y } | Measure-Object -Minimum).Minimum
  $right = ($words | ForEach-Object { $_.BoundingRect.X + $_.BoundingRect.Width } | Measure-Object -Maximum).Maximum
  $bottom = ($words | ForEach-Object { $_.BoundingRect.Y + $_.BoundingRect.Height } | Measure-Object -Maximum).Maximum
  $rect = [Windows.Foundation.Rect]::new($left, $top, ($right - $left), ($bottom - $top))
  $normalized = Normalize-Rect $rect $imageWidth $imageHeight

  $lines.Add(@{
    originalText = $line.Text
    confidence = 70
    x = $normalized.x
    y = $normalized.y
    width = $normalized.width
    height = $normalized.height
    words = @($words | ForEach-Object {
      $wordRect = Normalize-Rect $_.BoundingRect $imageWidth $imageHeight
      @{
        text = $_.Text
        x = $wordRect.x
        y = $wordRect.y
        width = $wordRect.width
        height = $wordRect.height
      }
    })
  })
}

@{
  ok = $true
  provider = "windows-ocr"
  imageWidth = $imageWidth
  imageHeight = $imageHeight
  lines = $lines
} | ConvertTo-Json -Depth 8 -Compress
