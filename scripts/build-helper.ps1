# Compiles resources/*.cs -> resources/*.exe
# Uses the .NET Framework compiler that ships with Windows.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'

if (-not (Test-Path $csc)) {
  Write-Warning 'csc.exe not found; skipping helper builds.'
  exit 0
}

$jobs = @(
  @{ Src = 'elevated-helper.cs'; Out = 'elevated-helper.exe'; Target = 'winexe'; Refs = @() },
  @{ Src = 'click-watcher.cs';   Out = 'click-watcher.exe';   Target = 'winexe'; Refs = @() },
  @{ Src = 'app-icon-helper.cs'; Out = 'app-icon-helper.exe'; Target = 'exe';    Refs = @('System.Drawing.dll') }
)

foreach ($job in $jobs) {
  $src = Join-Path $root "resources\$($job.Src)"
  $out = Join-Path $root "resources\$($job.Out)"
  if (-not (Test-Path $src)) {
    Write-Warning "$($job.Src) not found; skipping."
    continue
  }
  $args = @('/nologo', '/optimize+', "/target:$($job.Target)", "/out:$out", $src)
  foreach ($r in $job.Refs) { $args += "/reference:$r" }
  & $csc @args
  if ($LASTEXITCODE -ne 0) {
    Write-Error "Build $($job.Src) failed with exit code $LASTEXITCODE"
    exit $LASTEXITCODE
  }
  Write-Host "Built $out ($($job.Target))"
}
