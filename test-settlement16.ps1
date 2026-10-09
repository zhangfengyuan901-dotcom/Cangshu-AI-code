param([switch]$SkipBuild, [string]$TestImage = 'pikno-settlement16-test:local')
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
function Invoke-SettlementDocker {
    & docker @args
    if ($LASTEXITCODE -ne 0) { throw "Settlement 16 test failed: $($args[0])" }
}
if (-not $SkipBuild) {
    Invoke-SettlementDocker build -f "$PSScriptRoot/Dockerfile.settlement16" -t $TestImage $PSScriptRoot
}
$suffix = [Guid]::NewGuid().ToString('N').Substring(0,10)
$network = "pikno-settlement16-$suffix"
$pg = "$network-pg"
$mysql = "$network-mysql"
$created = [System.Collections.Generic.List[string]]::new()
try {
    Invoke-SettlementDocker network create --label pikno.settlement16.test=true $network
    Invoke-SettlementDocker run -d --name $pg --network $network --label pikno.settlement16.test=true -e POSTGRES_USER=settlement_test -e POSTGRES_PASSWORD=isolated-test-only -e POSTGRES_DB=settlement_test postgres:16-alpine
    $created.Add($pg)
    Invoke-SettlementDocker run -d --name $mysql --network $network --label pikno.settlement16.test=true -e MYSQL_ROOT_PASSWORD=isolated-test-only -e MYSQL_DATABASE=settlement_test mysql:8.0
    $created.Add($mysql)
    $ready = $false
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        & docker exec $pg pg_isready -U settlement_test *> $null
        $pgReady = $LASTEXITCODE -eq 0
        & docker exec -e MYSQL_PWD=isolated-test-only $mysql mysqladmin ping -h 127.0.0.1 --silent *> $null
        if ($pgReady -and $LASTEXITCODE -eq 0) { $ready = $true; break }
        Start-Sleep -Seconds 1
    }
    if (-not $ready) { throw 'Isolated database startup timeout.' }
    Invoke-SettlementDocker run --rm $TestImage
    Invoke-SettlementDocker run --rm --entrypoint /pikno-settlement-controller-test $TestImage '-test.run=^TestPiknoSettlement' '-test.v'
    Invoke-SettlementDocker run --rm --network $network -e PIKNO_SETTLEMENT_TEST_DRIVER=postgres -e "PIKNO_SETTLEMENT_TEST_DSN=host=$pg user=settlement_test password=isolated-test-only dbname=settlement_test sslmode=disable" $TestImage
    Invoke-SettlementDocker run --rm --network "container:$pg" --entrypoint /pikno-settlement-controller-test -e TEST_SECURITY_DIALECT=postgres -e 'TEST_POSTGRES_DSN=postgres://settlement_test:isolated-test-only@127.0.0.1:5432/settlement_test?sslmode=disable' $TestImage '-test.run=^TestPiknoSettlement' '-test.v'
    Invoke-SettlementDocker run --rm --network $network -e PIKNO_SETTLEMENT_TEST_DRIVER=mysql -e "PIKNO_SETTLEMENT_TEST_DSN=root:isolated-test-only@tcp($mysql`:3306)/settlement_test?charset=utf8mb4&parseTime=True&loc=Local" $TestImage
    Invoke-SettlementDocker run --rm --network "container:$mysql" --entrypoint /pikno-settlement-controller-test -e TEST_SECURITY_DIALECT=mysql -e 'TEST_MYSQL_DSN=root:isolated-test-only@tcp(127.0.0.1:3306)/settlement_test?charset=utf8mb4&parseTime=True&loc=Local' $TestImage '-test.run=^TestPiknoSettlement' '-test.v'
    Write-Output 'Settlement 16: model migration/accounting and authenticated HTTP/lifecycle/mail tests passed on all three databases.'
} finally {
    foreach ($name in $created) { & docker stop $name | Out-Null }
    Write-Output "Retained stopped isolated databases: $($created -join ', ')"
}
