# Draws the Forever AI Companion icon (gold ring like the in-game floating
# button, an engineering gear and the AI sparkle) at every size Windows uses,
# and packs them into assets/app.ico. Also writes PNGs for the app window.
#   powershell -ExecutionPolicy Bypass -File scripts/make-icon.ps1
param([string]$OutDir = (Join-Path $PSScriptRoot '..\assets'))

Add-Type -AssemblyName System.Drawing
New-Item -ItemType Directory -Force $OutDir | Out-Null

function C([string]$hex, [int]$a = 255) {
  $h = $hex.TrimStart('#')
  [System.Drawing.Color]::FromArgb($a, [Convert]::ToInt32($h.Substring(0, 2), 16), [Convert]::ToInt32($h.Substring(2, 2), 16), [Convert]::ToInt32($h.Substring(4, 2), 16))
}

function Circle($g, $brush, [double]$cx, [double]$cy, [double]$r) {
  $g.FillEllipse($brush, [single]($cx - $r), [single]($cy - $r), [single](2 * $r), [single](2 * $r))
}

function Star([double]$cx, [double]$cy, [double]$r, [double]$waist) {
  $pts = New-Object 'System.Drawing.PointF[]' 8
  for ($i = 0; $i -lt 8; $i++) {
    $a = [Math]::PI / 4 * $i - [Math]::PI / 2
    $rr = if ($i % 2 -eq 0) { $r } else { $r * $waist }
    $pts[$i] = New-Object System.Drawing.PointF ([single]($cx + [Math]::Cos($a) * $rr)), ([single]($cy + [Math]::Sin($a) * $rr))
  }
  return , $pts
}

function Gear([double]$cx, [double]$cy, [double]$outer, [double]$root, [int]$teeth) {
  $list = New-Object 'System.Collections.Generic.List[System.Drawing.PointF]'
  $step = 2 * [Math]::PI / $teeth
  for ($k = 0; $k -lt $teeth; $k++) {
    $base = $k * $step - [Math]::PI / 2
    foreach ($pair in @(@($root, -0.5), @($outer, -0.27), @($outer, 0.27), @($root, 0.5))) {
      $a = $base + $pair[1] * $step
      $list.Add((New-Object System.Drawing.PointF ([single]($cx + [Math]::Cos($a) * $pair[0])), ([single]($cy + [Math]::Sin($a) * $pair[0]))))
    }
  }
  return , $list.ToArray()
}

function Draw([int]$S) {
  $bmp = New-Object System.Drawing.Bitmap $S, $S, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.PixelOffsetMode = 'HighQuality'
  $g.Clear([System.Drawing.Color]::Transparent)
  $c = $S / 2.0
  $small = $S -lt 48

  # Gold ring.
  $ringR = $S * 0.48
  $rect = New-Object System.Drawing.RectangleF 0, 0, $S, $S
  $gold = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect, (C 'fbe7a1'), (C '8f6418'), 90
  Circle $g $gold $c $c $ringR
  $edge = New-Object System.Drawing.SolidBrush (C '2b1d05')
  $discR = $S * 0.40
  Circle $g $edge $c $c ($discR + [Math]::Max(1, $S * 0.012))

  # Dark night-blue disc with a soft light from the top.
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddEllipse([single]($c - $discR), [single]($c - $discR), [single](2 * $discR), [single](2 * $discR))
  $disc = New-Object System.Drawing.Drawing2D.PathGradientBrush $path
  $disc.CenterPoint = New-Object System.Drawing.PointF ([single]$c), ([single]($c - $discR * 0.35))
  $disc.CenterColor = C '33488a'
  $disc.SurroundColors = @(C '0a0f22')
  $g.FillPath($disc, $path)

  # The same design at every size (Explorer, taskbar, the app window): the
  # gear (engineering) around the sparkle (AI). Small sizes only drop the tiny
  # second sparkle, which would be a blur.
  $sparkTop = C 'ffffff'
  $sparkBottom = C '9db8ff'
  $gearBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect, (C 'ffe08a'), (C 'b8862c'), 90
  $outer = $S * ($(if ($small) { 0.33 } else { 0.315 }))
  $root = $S * ($(if ($small) { 0.265 } else { 0.255 }))
  $g.FillPolygon($gearBrush, (Gear $c $c $outer $root 8))
  Circle $g (New-Object System.Drawing.SolidBrush (C '0e1530')) $c $c ($S * 0.175)
  $sb = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect, $sparkTop, $sparkBottom, 90
  $g.FillPolygon($sb, (Star $c $c ($S * ($(if ($small) { 0.16 } else { 0.15 }))) 0.28))
  if ($S -ge 32) {
    $g.FillPolygon((New-Object System.Drawing.SolidBrush (C 'dfe8ff')), (Star ($c + $S * 0.235) ($c - $S * 0.235) ($S * 0.055) 0.3))
  }
  $g.Dispose()
  return $bmp
}

# Classic icon image (32-bit DIB + empty AND mask): readable by every Windows
# component. Only the 256 px image is stored as PNG, as Windows does.
function Dib($bmp) {
  $s = $bmp.Width
  $ms = New-Object System.IO.MemoryStream
  $w = New-Object System.IO.BinaryWriter $ms
  $maskRow = [int]([Math]::Ceiling($s / 32.0) * 4)
  $w.Write([UInt32]40); $w.Write([Int32]$s); $w.Write([Int32](2 * $s))
  $w.Write([UInt16]1); $w.Write([UInt16]32); $w.Write([UInt32]0)
  $w.Write([UInt32]($s * $s * 4 + $maskRow * $s)); $w.Write([Int32]0); $w.Write([Int32]0); $w.Write([UInt32]0); $w.Write([UInt32]0)
  for ($y = $s - 1; $y -ge 0; $y--) {
    for ($x = 0; $x -lt $s; $x++) {
      $px = $bmp.GetPixel($x, $y)
      $w.Write([byte]$px.B); $w.Write([byte]$px.G); $w.Write([byte]$px.R); $w.Write([byte]$px.A)
    }
  }
  $w.Write((New-Object byte[] ($maskRow * $s)))
  $w.Flush()
  return , $ms.ToArray()
}

$sizes = 16, 20, 24, 32, 40, 48, 64, 128, 256
$pngs = @()
foreach ($s in $sizes) {
  $bmp = Draw $s
  if ($s -ge 256) {
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $data = $ms.ToArray()
  } else {
    $data = Dib $bmp
  }
  $pngs += , @($s, $data)
  if ($s -in 64, 256) { $bmp.Save((Join-Path $OutDir "icon-$s.png"), [System.Drawing.Imaging.ImageFormat]::Png) }
  $bmp.Dispose()
}

# ICO file: DIB images, plus PNG for 256 px.
$out = New-Object System.IO.MemoryStream
$w = New-Object System.IO.BinaryWriter $out
$w.Write([UInt16]0); $w.Write([UInt16]1); $w.Write([UInt16]$pngs.Count)
$offset = 6 + 16 * $pngs.Count
foreach ($p in $pngs) {
  $s = $p[0]; $data = $p[1]
  $w.Write([byte]($(if ($s -ge 256) { 0 } else { $s }))); $w.Write([byte]($(if ($s -ge 256) { 0 } else { $s })))
  $w.Write([byte]0); $w.Write([byte]0)
  $w.Write([UInt16]1); $w.Write([UInt16]32)
  $w.Write([UInt32]$data.Length); $w.Write([UInt32]$offset)
  $offset += $data.Length
}
foreach ($p in $pngs) { $w.Write([byte[]]$p[1]) }
$w.Flush()
[IO.File]::WriteAllBytes((Join-Path $OutDir 'app.ico'), $out.ToArray())
Write-Output "Icono creado en $OutDir"
