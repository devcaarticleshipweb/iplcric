param(
  [int]$Port = 3000
)

$ErrorActionPreference = "Stop"
[System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$PublicDir = Join-Path $Root "public"
$RowStatsFile = Join-Path $Root "row-stats.json"
$BettingLedgerFile = Join-Path $Root "betting-ledger.json"
$Endpoint = "https://oddsapi.fair91.com/odds/event-fancy"
$LiveScoreEndpoint = "https://api.goscorer.com/api/v3/getSV3"
$CricbuzzLiveScoreEndpoint = "https://www.cricbuzz.com/api/mcenter/livescore"
$SheetId = "1pQQ6IedQjTdEAkfGjG7cGFFge5KXLrsDyTGKT56MevI"
$LoginSheetName = "Login Details"
$EventsSheetName = "Events"
$Prefix = "http://localhost:$Port/"
$SheetsApiUrl = $env:FAIR91_SHEETS_API_URL

$MimeTypes = @{
  ".html" = "text/html; charset=utf-8"
  ".css" = "text/css; charset=utf-8"
  ".js" = "application/javascript; charset=utf-8"
  ".json" = "application/json; charset=utf-8"
  ".svg" = "image/svg+xml"
  ".png" = "image/png"
  ".jpg" = "image/jpeg"
  ".jpeg" = "image/jpeg"
  ".ico" = "image/x-icon"
}

function Write-Response {
  param(
    [System.Net.HttpListenerResponse]$Response,
    [int]$StatusCode,
    [string]$ContentType,
    [byte[]]$Body
  )

  $Response.StatusCode = $StatusCode
  $Response.ContentType = $ContentType
  $Response.Headers.Set("Cache-Control", "no-store")
  $Response.ContentLength64 = $Body.Length
  $Response.OutputStream.Write($Body, 0, $Body.Length)
  $Response.OutputStream.Close()
}

function Write-Json {
  param(
    [System.Net.HttpListenerResponse]$Response,
    [int]$StatusCode,
    [object]$Payload
  )

  $Json = $Payload | ConvertTo-Json -Depth 100
  $Body = [System.Text.Encoding]::UTF8.GetBytes($Json)
  Write-Response -Response $Response -StatusCode $StatusCode -ContentType "application/json; charset=utf-8" -Body $Body
}

function Get-SheetsApiUrl {
  if (-not [string]::IsNullOrWhiteSpace($SheetsApiUrl)) {
    return $SheetsApiUrl.Trim()
  }

  $ConfigPath = Join-Path $Root "google-sheets-api-url.txt"
  if (Test-Path -LiteralPath $ConfigPath -PathType Leaf) {
    return (Get-Content -LiteralPath $ConfigPath -Raw).Trim()
  }

  return ""
}

function Get-QueryValue {
  param(
    [string]$Query,
    [string]$Name
  )

  $Params = [System.Web.HttpUtility]::ParseQueryString($Query)
  return $Params[$Name]
}

function ConvertTo-Hashtable {
  param([object]$InputObject)

  if ($null -eq $InputObject) {
    return $null
  }

  if ($InputObject -is [System.Collections.IDictionary]) {
    $Table = @{}
    foreach ($Key in $InputObject.Keys) {
      $Table[$Key] = ConvertTo-Hashtable $InputObject[$Key]
    }
    return $Table
  }

  if ($InputObject -is [System.Collections.IEnumerable] -and $InputObject -isnot [string]) {
    $List = @()
    foreach ($Item in $InputObject) {
      $List += ConvertTo-Hashtable $Item
    }
    return $List
  }

  if ($InputObject -is [pscustomobject]) {
    $Table = @{}
    foreach ($Property in $InputObject.PSObject.Properties) {
      $Table[$Property.Name] = ConvertTo-Hashtable $Property.Value
    }
    return $Table
  }

  return $InputObject
}

function Read-JsonBody {
  param([System.Net.HttpListenerRequest]$Request)

  $Reader = [System.IO.StreamReader]::new($Request.InputStream, $Request.ContentEncoding)
  try {
    $Body = $Reader.ReadToEnd()
  } finally {
    $Reader.Close()
  }

  if ([string]::IsNullOrWhiteSpace($Body)) {
    return @{}
  }

  return ConvertTo-Hashtable ($Body | ConvertFrom-Json)
}

function Invoke-SheetsApi {
  param(
    [string]$Action,
    [object]$Payload
  )

  $ApiUrl = Get-SheetsApiUrl
  if ([string]::IsNullOrWhiteSpace($ApiUrl)) {
    throw "Google Sheets API URL is not configured. Put the deployed Apps Script web app URL in google-sheets-api-url.txt or set FAIR91_SHEETS_API_URL."
  }

  $Body = @{
    action = $Action
    payload = $Payload
  } | ConvertTo-Json -Depth 100

  return Invoke-RestMethod -Uri $ApiUrl -Method Post -ContentType "application/json" -Body $Body -TimeoutSec 20 -Headers @{
    Accept = "application/json, text/plain, */*"
    "User-Agent" = "Fair91OddsViewer/1.0"
  }
}

function Handle-SheetsBackedApi {
  param(
    [System.Net.HttpListenerRequest]$Request,
    [System.Net.HttpListenerResponse]$Response
  )

  try {
    $Path = $Request.Url.AbsolutePath
    $Action = switch ($Path) {
      "/api/row-stats" { "rowStats"; break }
      "/api/betting-ledger" { "getLedger"; break }
      "/api/betting-auth" { "auth"; break }
      "/api/betting-users" { "createUser"; break }
      "/api/bets" { "placeBet"; break }
      "/api/bets/settle" { "settleBet"; break }
      default { "" }
    }

    if ([string]::IsNullOrWhiteSpace($Action)) {
      Write-Json -Response $Response -StatusCode 404 -Payload @{ error = "Unknown Google Sheets backed route." }
      return
    }

    $Payload = @{}
    if ($Request.HttpMethod -ne "GET") {
      $Payload = Read-JsonBody -Request $Request
    }

    $Result = Invoke-SheetsApi -Action $Action -Payload $Payload
    $StatusCode = if ($null -ne $Result.statusCode) { [int]$Result.statusCode } else { 200 }
    Write-Json -Response $Response -StatusCode $StatusCode -Payload $Result
  } catch {
    Write-Json -Response $Response -StatusCode 502 -Payload @{
      error = "Unable to read or write Google Sheets data."
      detail = $_.Exception.Message
    }
  }
}

function Get-NumericValue {
  param([object]$Value)

  $Number = 0.0
  if ([double]::TryParse([string]$Value, [System.Globalization.NumberStyles]::Float, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$Number)) {
    return $Number
  }
  return $null
}

function Get-RowStatsStore {
  if (-not (Test-Path -LiteralPath $RowStatsFile -PathType Leaf)) {
    return @{}
  }

  try {
    return ConvertTo-Hashtable ((Get-Content -LiteralPath $RowStatsFile -Raw) | ConvertFrom-Json)
  } catch {
    return @{}
  }
}

function Save-RowStatsStore {
  param([hashtable]$Store)

  $Json = $Store | ConvertTo-Json -Depth 100
  Set-Content -LiteralPath $RowStatsFile -Value $Json -Encoding UTF8
}

function Handle-RowStatsApi {
  param(
    [System.Net.HttpListenerRequest]$Request,
    [System.Net.HttpListenerResponse]$Response
  )

  if ($Request.HttpMethod -ne "POST") {
    Write-Json -Response $Response -StatusCode 405 -Payload @{ error = "Method not allowed." }
    return
  }

  try {
    $Body = Read-JsonBody -Request $Request
    $EventId = [string]$Body.eventId
    if ([string]::IsNullOrWhiteSpace($EventId)) {
      Write-Json -Response $Response -StatusCode 400 -Payload @{ error = "Missing required field: eventId" }
      return
    }

    $Rows = if ($null -ne $Body.rows) { @($Body.rows) } else { @() }
    $Store = Get-RowStatsStore
    if ($null -eq $Store -or $Store -isnot [System.Collections.IDictionary]) {
      $Store = @{}
    }

    if (-not $Store.ContainsKey($EventId)) {
      $Store[$EventId] = @{}
    }
    $EventStats = $Store[$EventId]
    if ($null -eq $EventStats -or $EventStats -isnot [System.Collections.IDictionary]) {
      $EventStats = @{}
    }

    foreach ($Row in $Rows) {
      $Key = [string]$Row.key
      if ([string]::IsNullOrWhiteSpace($Key)) {
        continue
      }

      $Values = @()
      $Back = Get-NumericValue -Value $Row.backPrice
      $Lay = Get-NumericValue -Value $Row.layPrice
      if ($null -ne $Back) { $Values += $Back }
      if ($null -ne $Lay) { $Values += $Lay }
      if ($Values.Count -eq 0) { continue }

      if (-not $EventStats.ContainsKey($Key)) {
        $EventStats[$Key] = @{ min = $null; max = $null }
      }

      $Current = $EventStats[$Key]
      $NowMin = ($Values | Measure-Object -Minimum).Minimum
      $NowMax = ($Values | Measure-Object -Maximum).Maximum
      if ($null -eq $Current -or $Current -isnot [System.Collections.IDictionary]) {
        $Current = @{ min = $null; max = $null }
      }

      $CurrentMin = Get-NumericValue -Value $Current["min"]
      $CurrentMax = Get-NumericValue -Value $Current["max"]
      $Current["min"] = if ($null -eq $CurrentMin) { $NowMin } else { [Math]::Min($CurrentMin, $NowMin) }
      $Current["max"] = if ($null -eq $CurrentMax) { $NowMax } else { [Math]::Max($CurrentMax, $NowMax) }
      $EventStats[$Key] = $Current
    }

    $Store[$EventId] = $EventStats
    Save-RowStatsStore -Store $Store

    Write-Json -Response $Response -StatusCode 200 -Payload @{
      eventId = $EventId
      fetchedAt = (Get-Date).ToUniversalTime().ToString("o")
      stats = $EventStats
    }
  } catch {
    Write-Json -Response $Response -StatusCode 400 -Payload @{
      error = "Unable to update row stats."
      detail = $_.Exception.Message
    }
  }
}

function Get-BettingLedger {
  if (-not (Test-Path -LiteralPath $BettingLedgerFile -PathType Leaf)) {
    return @{ users = @(); bets = @() }
  }

  try {
    $Ledger = ConvertTo-Hashtable ((Get-Content -LiteralPath $BettingLedgerFile -Raw) | ConvertFrom-Json)
    if ($null -eq $Ledger -or $Ledger -isnot [System.Collections.IDictionary]) {
      return @{ users = @(); bets = @() }
    }
    if (-not $Ledger.ContainsKey("users") -or $null -eq $Ledger["users"]) { $Ledger["users"] = @() }
    if (-not $Ledger.ContainsKey("bets") -or $null -eq $Ledger["bets"]) { $Ledger["bets"] = @() }
    return $Ledger
  } catch {
    return @{ users = @(); bets = @() }
  }
}

function Save-BettingLedger {
  param([hashtable]$Ledger)

  $Json = $Ledger | ConvertTo-Json -Depth 100
  Set-Content -LiteralPath $BettingLedgerFile -Value $Json -Encoding UTF8
}

function Get-BetProfit {
  param(
    [double]$Stake,
    [double]$Odds
  )

  if ($Odds -gt 20) {
    return [Math]::Round(($Stake * $Odds / 100), 2)
  }
  return [Math]::Round(($Stake * [Math]::Max(0, $Odds - 1)), 2)
}

function Get-FancyRateAmount {
  param(
    [double]$Stake,
    [double]$Rate
  )

  return [Math]::Round(($Stake * $Rate / 100), 2)
}

function Get-FancyLiability {
  param(
    [double]$Stake,
    [double]$Rate,
    [string]$Side
  )

  if ($Side -eq "No") {
    return Get-FancyRateAmount -Stake $Stake -Rate $Rate
  }
  return $Stake
}

function Get-FancyProfit {
  param(
    [double]$Stake,
    [double]$Rate,
    [string]$Side
  )

  if ($Side -eq "Yes") {
    return Get-FancyRateAmount -Stake $Stake -Rate $Rate
  }
  return $Stake
}

function Get-PublicLedger {
  param([hashtable]$Ledger)

  $Users = @($Ledger["users"])
  $Bets = @($Ledger["bets"])
  $Summary = @()

  foreach ($User in $Users) {
    $Username = [string]$User.username
    $UserBets = @($Bets | Where-Object { ([string]$_.username).ToLowerInvariant() -eq $Username.ToLowerInvariant() })
    $Pending = @($UserBets | Where-Object { $_.status -eq "PENDING" })
    $Settled = @($UserBets | Where-Object { $_.status -eq "SETTLED" })
    $TotalStake = ($UserBets | Measure-Object -Property stake -Sum).Sum
    $Exposure = ($Pending | Measure-Object -Property stake -Sum).Sum
    $Pnl = ($Settled | Measure-Object -Property pnl -Sum).Sum

    $Summary += [ordered]@{
      username = $Username
      name = $User.name
      balance = Get-NumericValue -Value $User.balance
      totalStake = if ($null -eq $TotalStake) { 0 } else { $TotalStake }
      exposure = if ($null -eq $Exposure) { 0 } else { $Exposure }
      pnl = if ($null -eq $Pnl) { 0 } else { $Pnl }
      betCount = $UserBets.Count
    }
  }

  $SafeUsers = @($Users | ForEach-Object {
    [ordered]@{
      username = $_.username
      name = $_.name
      role = $_.role
      balance = $_.balance
      createdAt = $_.createdAt
    }
  })

  return @{
    users = $SafeUsers
    bets = $Bets
    summary = $Summary
  }
}

function Handle-BettingLedgerApi {
  param(
    [System.Net.HttpListenerRequest]$Request,
    [System.Net.HttpListenerResponse]$Response
  )

  $Ledger = Get-BettingLedger
  Write-Json -Response $Response -StatusCode 200 -Payload (Get-PublicLedger -Ledger $Ledger)
}

function Handle-BettingUsersApi {
  param(
    [System.Net.HttpListenerRequest]$Request,
    [System.Net.HttpListenerResponse]$Response
  )

  if ($Request.HttpMethod -ne "POST") {
    Write-Json -Response $Response -StatusCode 405 -Payload @{ error = "Method not allowed." }
    return
  }

  try {
    $Body = Read-JsonBody -Request $Request
    $Username = ([string]$Body.username).Trim()
    $Password = [string]$Body.password
    $Name = if ([string]::IsNullOrWhiteSpace([string]$Body.name)) { $Username } else { [string]$Body.name }
    $Balance = Get-NumericValue -Value $Body.balance

    if ([string]::IsNullOrWhiteSpace($Username) -or [string]::IsNullOrWhiteSpace($Password)) {
      Write-Json -Response $Response -StatusCode 400 -Payload @{ error = "Username and password are required." }
      return
    }
    if ($null -eq $Balance -or $Balance -lt 0) { $Balance = 0 }

    $Ledger = Get-BettingLedger
    $Users = @($Ledger["users"])
    if (@($Users | Where-Object { ([string]$_.username).ToLowerInvariant() -eq $Username.ToLowerInvariant() }).Count -gt 0) {
      Write-Json -Response $Response -StatusCode 409 -Payload @{ error = "User already exists." }
      return
    }

    $User = [ordered]@{
      username = $Username
      password = $Password
      name = $Name
      role = "user"
      balance = $Balance
      createdAt = (Get-Date).ToUniversalTime().ToString("o")
    }
    $Ledger["users"] = @($Users + $User)
    Save-BettingLedger -Ledger $Ledger

    Write-Json -Response $Response -StatusCode 200 -Payload @{ user = [ordered]@{ username = $Username; name = $Name; role = "user"; balance = $Balance } }
  } catch {
    Write-Json -Response $Response -StatusCode 400 -Payload @{ error = "Unable to create user."; detail = $_.Exception.Message }
  }
}

function Handle-BettingAuthApi {
  param(
    [System.Net.HttpListenerRequest]$Request,
    [System.Net.HttpListenerResponse]$Response
  )

  if ($Request.HttpMethod -ne "POST") {
    Write-Json -Response $Response -StatusCode 405 -Payload @{ error = "Method not allowed." }
    return
  }

  try {
    $Body = Read-JsonBody -Request $Request
    $Username = ([string]$Body.username).Trim()
    $Password = [string]$Body.password
    $Ledger = Get-BettingLedger
    $User = @(@($Ledger["users"]) | Where-Object {
      ([string]$_.username).ToLowerInvariant() -eq $Username.ToLowerInvariant() -and [string]$_.password -eq $Password
    } | Select-Object -First 1)

    if ($User.Count -eq 0) {
      Write-Json -Response $Response -StatusCode 401 -Payload @{ error = "Invalid username or password." }
      return
    }

    $User = $User[0]
    Write-Json -Response $Response -StatusCode 200 -Payload @{
      user = [ordered]@{
        username = $User.username
        name = $User.name
        role = $User.role
        balance = $User.balance
      }
    }
  } catch {
    Write-Json -Response $Response -StatusCode 400 -Payload @{ error = "Unable to authenticate."; detail = $_.Exception.Message }
  }
}

function Handle-BetsApi {
  param(
    [System.Net.HttpListenerRequest]$Request,
    [System.Net.HttpListenerResponse]$Response
  )

  if ($Request.HttpMethod -ne "POST") {
    Write-Json -Response $Response -StatusCode 405 -Payload @{ error = "Method not allowed." }
    return
  }

  try {
    $Body = Read-JsonBody -Request $Request
    $Username = ([string]$Body.username).Trim()
    $Stake = Get-NumericValue -Value $Body.stake
    $Odds = Get-NumericValue -Value $Body.odds
    $Liability = Get-NumericValue -Value $Body.liability
    $IsFancy = $Body.marketType -eq "FANCY"
    $Rate = if ($IsFancy) { Get-NumericValue -Value $Body.rate } else { $null }
    $Run = ""
    $Target = ""
    if ($IsFancy) {
      $Run = Get-NumericValue -Value $Body.run
      if ($null -eq $Run) { $Run = Get-NumericValue -Value $Body.target }
      if ($null -eq $Run) { $Run = $Odds }
      $Target = Get-NumericValue -Value $Body.target
      if ($null -eq $Target) { $Target = Get-NumericValue -Value $Body.run }
      if ($null -eq $Target) { $Target = $Odds }
    }
    if ([string]::IsNullOrWhiteSpace($Username) -or $null -eq $Stake -or $Stake -le 0 -or $null -eq $Odds -or $Odds -le 0) {
      Write-Json -Response $Response -StatusCode 400 -Payload @{ error = "Valid username, stake and odds are required." }
      return
    }
    if ($IsFancy -and $null -eq $Rate) { $Rate = 100 }
    if ($null -eq $Liability -or $Liability -le 0) {
      $Liability = if ($IsFancy) { Get-FancyLiability -Stake $Stake -Rate $Rate -Side $Body.side } else { $Stake }
    }

    $Ledger = Get-BettingLedger
    $Users = @($Ledger["users"])
    $User = @($Users | Where-Object { ([string]$_.username).ToLowerInvariant() -eq $Username.ToLowerInvariant() } | Select-Object -First 1)
    if ($User.Count -eq 0) {
      Write-Json -Response $Response -StatusCode 404 -Payload @{ error = "User not found in betting ledger. Master must create the user first." }
      return
    }
    $User = $User[0]
    $Balance = Get-NumericValue -Value $User.balance
    if ($null -eq $Balance) { $Balance = 0 }
    if ($Balance -lt $Liability) {
      Write-Json -Response $Response -StatusCode 400 -Payload @{ error = "Insufficient balance." }
      return
    }

    $User.balance = [Math]::Round(($Balance - $Liability), 2)
    $Bet = [ordered]@{
      id = [guid]::NewGuid().ToString("N").Substring(0, 12)
      username = $Username
      eventId = $Body.eventId
      eventName = $Body.eventName
      marketKey = $Body.marketKey
      marketName = $Body.marketName
      marketType = $Body.marketType
      side = $Body.side
      odds = $Odds
      run = $Run
      target = $Target
      rate = if ($IsFancy) { $Rate } else { "" }
      stake = $Stake
      liability = $Liability
      estimatedProfit = if ($IsFancy) { Get-FancyProfit -Stake $Stake -Rate $Rate -Side $Body.side } else { Get-BetProfit -Stake $Stake -Odds $Odds }
      status = "PENDING"
      result = ""
      pnl = 0
      placedAt = (Get-Date).ToUniversalTime().ToString("o")
    }
    $Ledger["bets"] = @(@($Ledger["bets"]) + $Bet)
    Save-BettingLedger -Ledger $Ledger

    Write-Json -Response $Response -StatusCode 200 -Payload @{ bet = $Bet; ledger = (Get-PublicLedger -Ledger $Ledger) }
  } catch {
    Write-Json -Response $Response -StatusCode 400 -Payload @{ error = "Unable to place bet."; detail = $_.Exception.Message }
  }
}

function Handle-BetSettleApi {
  param(
    [System.Net.HttpListenerRequest]$Request,
    [System.Net.HttpListenerResponse]$Response
  )

  if ($Request.HttpMethod -ne "POST") {
    Write-Json -Response $Response -StatusCode 405 -Payload @{ error = "Method not allowed." }
    return
  }

  try {
    $Body = Read-JsonBody -Request $Request
    $BetId = [string]$Body.betId
    $Result = ([string]$Body.result).ToUpperInvariant()
    $Ledger = Get-BettingLedger
    $Bets = @($Ledger["bets"])
    $Bet = @($Bets | Where-Object { [string]$_.id -eq $BetId } | Select-Object -First 1)
    if ($Bet.Count -eq 0) {
      Write-Json -Response $Response -StatusCode 404 -Payload @{ error = "Bet not found." }
      return
    }
    $Bet = $Bet[0]
    if ($Bet.status -ne "PENDING") {
      Write-Json -Response $Response -StatusCode 400 -Payload @{ error = "Bet is already settled." }
      return
    }

    $User = @(@($Ledger["users"]) | Where-Object { ([string]$_.username).ToLowerInvariant() -eq ([string]$Bet.username).ToLowerInvariant() } | Select-Object -First 1)[0]
    $Balance = Get-NumericValue -Value $User.balance
    if ($null -eq $Balance) { $Balance = 0 }
    $Stake = Get-NumericValue -Value $Bet.stake
    $Liability = Get-NumericValue -Value $Bet.liability
    $Profit = Get-NumericValue -Value $Bet.estimatedProfit
    if ($null -eq $Stake) { $Stake = 0 }
    if ($null -eq $Liability) { $Liability = $Stake }
    if ($null -eq $Profit) { $Profit = 0 }

    if ($Result -eq "WIN") {
      $Bet.pnl = $Profit
      $User.balance = [Math]::Round(($Balance + $Liability + $Profit), 2)
    } elseif ($Result -eq "LOSE") {
      $Bet.pnl = -1 * $Liability
    } elseif ($Result -eq "VOID") {
      $Bet.pnl = 0
      $User.balance = [Math]::Round(($Balance + $Liability), 2)
    } else {
      Write-Json -Response $Response -StatusCode 400 -Payload @{ error = "Result must be WIN, LOSE or VOID." }
      return
    }

    $Bet.status = "SETTLED"
    $Bet.result = $Result
    $Bet.settledAt = (Get-Date).ToUniversalTime().ToString("o")
    Save-BettingLedger -Ledger $Ledger
    Write-Json -Response $Response -StatusCode 200 -Payload @{ bet = $Bet; ledger = (Get-PublicLedger -Ledger $Ledger) }
  } catch {
    Write-Json -Response $Response -StatusCode 400 -Payload @{ error = "Unable to settle bet."; detail = $_.Exception.Message }
  }
}

function Handle-Api {
  param(
    [System.Net.HttpListenerRequest]$Request,
    [System.Net.HttpListenerResponse]$Response
  )

  $Id = Get-QueryValue -Query $Request.Url.Query -Name "id"
  if ([string]::IsNullOrWhiteSpace($Id)) {
    Write-Json -Response $Response -StatusCode 400 -Payload @{ error = "Missing required query parameter: id" }
    return
  }

  $CleanId = $Id.Trim()
  $UpstreamUrl = $Endpoint + "?id=" + [System.Uri]::EscapeDataString($CleanId) + "&_=" + [System.Uri]::EscapeDataString(([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds().ToString()))

  try {
    $ApiResponse = Invoke-RestMethod -Uri $UpstreamUrl -Method Get -TimeoutSec 12 -Headers @{
      Accept = "application/json, text/plain, */*"
      "Cache-Control" = "no-cache"
      Pragma = "no-cache"
      "User-Agent" = "Fair91OddsViewer/1.0"
    }

    Write-Json -Response $Response -StatusCode 200 -Payload @{
      id = $CleanId
      fetchedAt = (Get-Date).ToUniversalTime().ToString("o")
      source = $UpstreamUrl
      data = $ApiResponse
    }
  } catch {
    Write-Json -Response $Response -StatusCode 502 -Payload @{
      error = "Unable to fetch odds from the remote API."
      detail = $_.Exception.Message
    }
  }
}

function Parse-GvizResponse {
  param([string]$RawText)

  $Start = $RawText.IndexOf("{")
  $End = $RawText.LastIndexOf("}")

  if ($Start -lt 0 -or $End -le $Start) {
    throw "Invalid Google Sheets response format."
  }

  $JsonText = $RawText.Substring($Start, ($End - $Start + 1))
  $Payload = $JsonText | ConvertFrom-Json

  $Cols = @($Payload.table.cols)
  $Rows = @($Payload.table.rows)
  $Headers = @()

  for ($i = 0; $i -lt $Cols.Count; $i++) {
    $Label = [string]$Cols[$i].label
    if ([string]::IsNullOrWhiteSpace($Label)) {
      $Label = [string]$Cols[$i].id
    }
    if ([string]::IsNullOrWhiteSpace($Label)) {
      $Label = "col$($i + 1)"
    }
    $Headers += $Label.Trim()
  }

  $Out = @()
  foreach ($Row in $Rows) {
    $Obj = [ordered]@{}
    $Cells = @($Row.c)
    for ($i = 0; $i -lt $Headers.Count; $i++) {
      $Cell = if ($i -lt $Cells.Count) { $Cells[$i] } else { $null }
      $Value = ""
      if ($null -ne $Cell) {
        if ($null -ne $Cell.f -and "$($Cell.f)".Length -gt 0) {
          $Value = [string]$Cell.f
        } elseif ($null -ne $Cell.v) {
          $Value = [string]$Cell.v
        }
      }
      $Obj[$Headers[$i]] = $Value
    }
    $Out += [PSCustomObject]$Obj
  }

  return $Out
}

function Get-SheetRows {
  param([string]$SheetName)

  $Url = "https://docs.google.com/spreadsheets/d/$SheetId/gviz/tq?sheet=$([System.Uri]::EscapeDataString($SheetName))&tqx=out:json"
  $Response = Invoke-WebRequest -Uri $Url -Method Get -TimeoutSec 12 -Headers @{
    Accept = "text/plain, */*"
    "User-Agent" = "Fair91OddsViewer/1.0"
  }

  return Parse-GvizResponse -RawText $Response.Content
}

function Handle-SheetConfigApi {
  param(
    [System.Net.HttpListenerRequest]$Request,
    [System.Net.HttpListenerResponse]$Response
  )

  try {
    $LoginRows = Get-SheetRows -SheetName $LoginSheetName
    $EventRows = Get-SheetRows -SheetName $EventsSheetName

    Write-Json -Response $Response -StatusCode 200 -Payload @{
      fetchedAt = (Get-Date).ToUniversalTime().ToString("o")
      loginRows = $LoginRows
      eventRows = $EventRows
    }
  } catch {
    Write-Json -Response $Response -StatusCode 502 -Payload @{
      error = "Unable to load Google Sheet configuration."
      detail = $_.Exception.Message
    }
  }
}

function Handle-LiveScoreApi {
  param(
    [System.Net.HttpListenerRequest]$Request,
    [System.Net.HttpListenerResponse]$Response
  )

  $Key = Get-QueryValue -Query $Request.Url.Query -Name "key"
  $MatchId = Get-QueryValue -Query $Request.Url.Query -Name "matchId"
  $PathMatch = [regex]::Match($Request.Url.AbsolutePath, "^/api/mcenter/livescore/([^/]+)$")

  if ([string]::IsNullOrWhiteSpace($MatchId) -and $PathMatch.Success) {
    $MatchId = [System.Uri]::UnescapeDataString($PathMatch.Groups[1].Value)
  }

  if ([string]::IsNullOrWhiteSpace($Key) -and [string]::IsNullOrWhiteSpace($MatchId)) {
    Write-Json -Response $Response -StatusCode 400 -Payload @{ error = "Missing live score key or Cricbuzz match ID." }
    return
  }

  if (-not [string]::IsNullOrWhiteSpace($MatchId)) {
    $SourceType = "cricbuzz"
    $UpstreamUrl = $CricbuzzLiveScoreEndpoint + "/" + [System.Uri]::EscapeDataString($MatchId.Trim())
  } else {
    $SourceType = "goscorer"
    $UpstreamUrl = $LiveScoreEndpoint + "?key=" + [System.Uri]::EscapeDataString($Key.Trim())
  }

  try {
    $ApiResponse = Invoke-RestMethod -Uri $UpstreamUrl -Method Get -TimeoutSec 8 -Headers @{
      Accept = "application/json, text/plain, */*"
      Referer = "https://www.cricbuzz.com/"
      "User-Agent" = "Fair91OddsViewer/1.0"
    }

    Write-Json -Response $Response -StatusCode 200 -Payload @{
      fetchedAt = (Get-Date).ToUniversalTime().ToString("o")
      sourceType = $SourceType
      source = $UpstreamUrl
      data = $ApiResponse
    }
  } catch {
    Write-Json -Response $Response -StatusCode 502 -Payload @{
      error = "Unable to fetch live score."
      detail = $_.Exception.Message
    }
  }
}

function Handle-Static {
  param(
    [System.Net.HttpListenerRequest]$Request,
    [System.Net.HttpListenerResponse]$Response
  )

  $PathName = [System.Uri]::UnescapeDataString($Request.Url.AbsolutePath)
  if ($PathName -eq "/") {
    $PathName = "/index.html"
  }

  $RelativePath = $PathName.TrimStart("/") -replace "/", [System.IO.Path]::DirectorySeparatorChar
  $FilePath = [System.IO.Path]::GetFullPath((Join-Path $PublicDir $RelativePath))
  $PublicRoot = [System.IO.Path]::GetFullPath($PublicDir)

  if (-not $FilePath.StartsWith($PublicRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    $Body = [System.Text.Encoding]::UTF8.GetBytes("Forbidden")
    Write-Response -Response $Response -StatusCode 403 -ContentType "text/plain; charset=utf-8" -Body $Body
    return
  }

  if (-not (Test-Path -LiteralPath $FilePath -PathType Leaf)) {
    $Body = [System.Text.Encoding]::UTF8.GetBytes("Not found")
    Write-Response -Response $Response -StatusCode 404 -ContentType "text/plain; charset=utf-8" -Body $Body
    return
  }

  $Extension = [System.IO.Path]::GetExtension($FilePath)
  $ContentType = if ($MimeTypes.ContainsKey($Extension)) { $MimeTypes[$Extension] } else { "application/octet-stream" }
  $Body = [System.IO.File]::ReadAllBytes($FilePath)
  Write-Response -Response $Response -StatusCode 200 -ContentType $ContentType -Body $Body
}

Add-Type -AssemblyName System.Web

$Listener = [System.Net.HttpListener]::new()
$Listener.Prefixes.Add($Prefix)
$Listener.Start()

Write-Host "Fair91 odds viewer running at $Prefix"
Write-Host "Press Ctrl+C to stop."

try {
  while ($Listener.IsListening) {
    $Context = $Listener.GetContext()
    $Request = $Context.Request
    $Response = $Context.Response

    if ($Request.Url.AbsolutePath -eq "/api/event-fancy") {
      Handle-Api -Request $Request -Response $Response
    } elseif ($Request.Url.AbsolutePath -eq "/api/sheet-config") {
      Handle-SheetConfigApi -Request $Request -Response $Response
    } elseif ($Request.Url.AbsolutePath -eq "/api/row-stats") {
      Handle-SheetsBackedApi -Request $Request -Response $Response
    } elseif ($Request.Url.AbsolutePath -eq "/api/betting-ledger") {
      Handle-SheetsBackedApi -Request $Request -Response $Response
    } elseif ($Request.Url.AbsolutePath -eq "/api/betting-auth") {
      Handle-SheetsBackedApi -Request $Request -Response $Response
    } elseif ($Request.Url.AbsolutePath -eq "/api/betting-users") {
      Handle-SheetsBackedApi -Request $Request -Response $Response
    } elseif ($Request.Url.AbsolutePath -eq "/api/bets") {
      Handle-SheetsBackedApi -Request $Request -Response $Response
    } elseif ($Request.Url.AbsolutePath -eq "/api/bets/settle") {
      Handle-SheetsBackedApi -Request $Request -Response $Response
    } elseif ($Request.Url.AbsolutePath -eq "/api/live-score" -or $Request.Url.AbsolutePath.StartsWith("/api/mcenter/livescore/")) {
      Handle-LiveScoreApi -Request $Request -Response $Response
    } else {
      Handle-Static -Request $Request -Response $Response
    }
  }
} finally {
  $Listener.Stop()
  $Listener.Close()
}
