# ============================================================
# PROJECT ORBIT — Leadership Roster Export
# Reads ORBIT_Leadership.xlsx (AM | DOMAIN | MANAGER | ROLE | EMAIL)
# and writes orbit-auth.js (const D_LEADERSHIP = [...]).
#
# The xlsx is the single source of truth for authorization.
# DOMAIN is the unique security key. No names are hardcoded in
# orbit-app.js — all role checks run against this generated file.
#
# Called by Refresh_ORBIT.ps1 (STEP 2.5) or run standalone.
# ============================================================
$LEADERSHIP_XLSX = "C:\Users\AL70683\OneDrive - Elevance Health\IGNITE PROJECTS\ORBIT\ORBIT_Leadership.xlsx"
$DASH_DIR        = "C:\Users\AL70683\OneDrive - Elevance Health\IGNITE PROJECTS\ORBIT\ORBIT DASH"
$OUT_FILE        = "$DASH_DIR\orbit-auth.js"

function Log($msg, $color="White") {
    $ts = (Get-Date).ToString("HH:mm:ss")
    Write-Host "[$ts] $msg" -ForegroundColor $color
}
function EscJ($s) {
    $s2 = [string]$s
    $s2 = $s2.Replace('\','\\').Replace('"','\"')
    return $s2
}

if (-not (Test-Path $LEADERSHIP_XLSX)) {
    Log "  [WARN] ORBIT_Leadership.xlsx not found - writing EMPTY roster" Yellow
    [System.IO.File]::WriteAllText($OUT_FILE,
        "// ORBIT Leadership roster`n// Generated: $(Get-Date -Format 'yyyy-MM-dd HH:mm')`n// Source file missing - no authorized users`nconst D_LEADERSHIP=[];`n",
        [System.Text.Encoding]::UTF8)
    exit 0
}

# Open read-only copy — never saves changes to the source file
$xl = New-Object -ComObject Excel.Application
$xl.Visible = $false
$xl.DisplayAlerts = $false
$xl.ScreenUpdating = $false

try {
    $wb = $xl.Workbooks.Open($LEADERSHIP_XLSX, 0, $true)   # UpdateLinks=0, ReadOnly=true
    $ws = $wb.Worksheets.Item(1)
    $ur = $ws.UsedRange

    # Locate columns by header text (tolerates typos like DOMIAIN)
    $colAM = $null; $colDomain = $null; $colMgr = $null; $colRole = $null; $colEmail = $null
    for ($c = 1; $c -le $ur.Columns.Count; $c++) {
        $h = "$($ur.Cells.Item(1,$c).Text)".Trim().ToUpper()
        if ($h -match '^AM$')                          { $colAM     = $c }
        elseif ($h -match 'DOM')                       { $colDomain = $c }
        elseif ($h -match 'MANAGER')                   { $colMgr    = $c }
        elseif ($h -match 'ROLE|FUNCTION')             { $colRole   = $c }
        elseif ($h -match 'EMAIL|E-MAIL|MAIL')         { $colEmail  = $c }
    }
    if (-not $colDomain -or -not $colRole) {
        throw "Required columns not found in ORBIT_Leadership.xlsx (need DOMAIN + ROLE)"
    }

    $rows = [System.Collections.ArrayList]::new()
    for ($r = 2; $r -le $ur.Rows.Count; $r++) {
        $domain = if ($colDomain) { "$($ur.Cells.Item($r,$colDomain).Text)".Trim() } else { "" }
        if ($domain -eq "") { continue }
        $am     = if ($colAM)     { "$($ur.Cells.Item($r,$colAM).Text)".Trim() }     else { "" }
        $mgr    = if ($colMgr)    { "$($ur.Cells.Item($r,$colMgr).Text)".Trim() }    else { "" }
        $role   = if ($colRole)   { "$($ur.Cells.Item($r,$colRole).Text)".Trim() }   else { "" }
        $email  = if ($colEmail)  { "$($ur.Cells.Item($r,$colEmail).Text)".Trim() }  else { "" }

        # Normalize role: ADMIN -> admin, everything else -> leadership
        $roleNorm = if ($role -match 'admin') { 'admin' } else { 'leadership' }

        $null = $rows.Add(@{
            am = $am; domain = $domain; manager = $mgr
            role = $roleNorm; email = $email
        })
    }
    $wb.Close($false)

    # Write orbit-auth.js
    $sb = [System.Text.StringBuilder]::new()
    [void]$sb.Append("// ORBIT Leadership roster - generated file`n")
    [void]$sb.Append("// Generated: $(Get-Date -Format 'yyyy-MM-dd HH:mm')`n")
    [void]$sb.Append("// Source: ORBIT_Leadership.xlsx (single source of truth for authorization)`n")
    [void]$sb.Append("// DOMAIN is the unique security key - do not edit by hand`n")
    [void]$sb.Append("const D_LEADERSHIP=[`n")
    $fi = $true
    foreach ($r in $rows) {
        if (-not $fi) { [void]$sb.Append(",`n") }; $fi = $false
        [void]$sb.Append("  {`"am`":`"$(EscJ $r.am)`",`"domain`":`"$(EscJ $r.domain)`",`"manager`":`"$(EscJ $r.manager)`",`"role`":`"$($r.role)`",`"email`":`"$(EscJ $r.email)`"}")
    }
    [void]$sb.Append("`n];`n")
    [System.IO.File]::WriteAllText($OUT_FILE, $sb.ToString(), [System.Text.Encoding]::UTF8)

    $admins = ($rows | Where-Object { $_.role -eq 'admin' }).Count
    Log "  orbit-auth.js written: $($rows.Count) authorized users ($admins admin, $($rows.Count - $admins) leadership)" Green
}
finally {
    $xl.Quit()
    [System.Runtime.InteropServices.Marshal]::ReleaseComObject($xl) | Out-Null
    [GC]::Collect()
}
