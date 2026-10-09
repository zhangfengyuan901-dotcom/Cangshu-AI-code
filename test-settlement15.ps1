param([switch]$SkipBuild)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Only isolated, task-owned local containers; no published ports or real keys.
function Invoke-TestDocker {
    & docker @args
    if ($LASTEXITCODE -ne 0) { throw "Docker test command failed: $($args[0])" }
}

if (-not $SkipBuild) {
    Invoke-TestDocker build -f "$PSScriptRoot/Dockerfile.settlement15" -t pikno-settlement15-test:local $PSScriptRoot
}

$runID = [Guid]::NewGuid().ToString('N').Substring(0,10)
$network = "pikno-settlement15-$runID"
$pg = "$network-pg"
$mysql = "$network-mysql"
$created = [System.Collections.Generic.List[string]]::new()
try {
    Invoke-TestDocker network create --label pikno.settlement15.test=true $network
    Invoke-TestDocker run -d --name $pg --network $network --label pikno.settlement15.test=true -e POSTGRES_USER=settlement_test -e POSTGRES_PASSWORD=isolated-test-only -e POSTGRES_DB=settlement_test postgres:16-alpine
    $created.Add($pg)
    Invoke-TestDocker run -d --name $mysql --network $network --label pikno.settlement15.test=true -e MYSQL_ROOT_PASSWORD=isolated-test-only -e MYSQL_DATABASE=settlement_test mysql:8.0
    $created.Add($mysql)

    $ready = $false
    for ($attempt=0; $attempt -lt 60; $attempt++) {
        & docker exec $pg pg_isready -U settlement_test *> $null
        $pgReady = $LASTEXITCODE -eq 0
        # TCP verifies final MySQL startup, not its initialization-only socket.
        & docker exec -e MYSQL_PWD=isolated-test-only $mysql mysqladmin ping -h 127.0.0.1 --silent *> $null
        $mysqlReady = $LASTEXITCODE -eq 0
        if ($pgReady -and $mysqlReady) { $ready=$true; break }
        Start-Sleep -Seconds 1
    }
    if (-not $ready) { throw 'Isolated databases were not ready in 60 seconds.' }

    Invoke-TestDocker run --rm pikno-settlement15-test:local
    Invoke-TestDocker run --rm --network $network -e PIKNO_SETTLEMENT_TEST_DRIVER=postgres -e "PIKNO_SETTLEMENT_TEST_DSN=host=$pg user=settlement_test password=isolated-test-only dbname=settlement_test sslmode=disable" pikno-settlement15-test:local
    Invoke-TestDocker run --rm --network $network -e PIKNO_SETTLEMENT_TEST_DRIVER=mysql -e "PIKNO_SETTLEMENT_TEST_DSN=root:isolated-test-only@tcp($mysql`:3306)/settlement_test?charset=utf8mb4&parseTime=True&loc=Local" pikno-settlement15-test:local
    Write-Output 'Settlement 15: SQLite, PostgreSQL and MySQL all passed.'
} finally {
    # Preserve test databases for inspection; only stop containers created by
    # this invocation. Never touch the relay or existing wallet test containers.
    foreach ($name in $created) { & docker stop $name | Out-Null }
    Write-Output "Retained stopped test containers: $($created -join ', ')"
}
