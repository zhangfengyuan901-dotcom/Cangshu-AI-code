package main

import (
	"go/ast"
	"go/parser"
	"go/token"
	"testing"
)

func TestPiknoLineSyncStartupMigrationIsIndependentAndPrecedesWorkers(t *testing.T) {
	file, err := parser.ParseFile(token.NewFileSet(), "main.go", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	var entry *ast.FuncDecl
	for _, declaration := range file.Decls {
		if function, ok := declaration.(*ast.FuncDecl); ok && function.Name.Name == "main" {
			entry = function
		}
	}
	if entry == nil {
		t.Fatal("main entry point missing")
	}
	containsCall := func(node ast.Node, name string) bool {
		found := false
		ast.Inspect(node, func(node ast.Node) bool {
			call, ok := node.(*ast.CallExpr)
			if !ok {
				return true
			}
			function, ok := call.Fun.(*ast.SelectorExpr)
			if ok && function.Sel.Name == name {
				found = true
			}
			return true
		})
		return found
	}
	llm, syncMigration, worker := -1, -1, -1
	for index, statement := range entry.Body.List {
		if containsCall(statement, "MigratePiknoLLM") {
			llm = index
			if containsCall(statement, "MigratePiknoLineSync") {
				t.Fatal("line synchronization migration is nested in the LLM error path")
			}
		}
		if containsCall(statement, "MigratePiknoLineSync") {
			syncMigration = index
		}
		if containsCall(statement, "StartPiknoLineSyncScheduler") {
			worker = index
		}
	}
	if llm < 0 || syncMigration <= llm || worker <= syncMigration {
		t.Fatalf("startup order invalid: llm=%d line_sync=%d worker=%d", llm, syncMigration, worker)
	}
}
