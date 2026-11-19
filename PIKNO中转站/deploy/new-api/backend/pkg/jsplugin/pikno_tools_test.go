package jsplugin

import (
 "context"
 "os"
 "testing"
 "github.com/stretchr/testify/require"
)

func TestPiknoTools(t *testing.T) {
 source,err:=os.ReadFile("/build/pikno-tools.js");require.NoError(t,err)
 fixture,err:=os.ReadFile("/build/pikno-tools.fixture.json");require.NoError(t,err)
 plugin,err:=NewRegistry().Register(string(source),Options{Key:"pikno-tools",Version:"candidate"});require.NoError(t,err)
 require.Equal(t,"pikno-tools",plugin.Meta.Key)
 report,err:=ReplayFixture(context.Background(),string(source),fixture);require.NoError(t,err)
 require.Equal(t,report.Total,report.Passed);require.GreaterOrEqual(t,report.Passed,8)
}
