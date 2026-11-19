"""Offline smoke check for the shipped Python and creative modules."""
import sys
from pathlib import Path

workflow=Path(sys.argv[1]).resolve()
sys.path.insert(0,str(workflow))
from creative_result import display_result, Script
from creative import Creative

result=display_result('{"summary":"partial","shots":[',Script)
assert result.summary=='partial'
result=display_result('{"shots":[{"start":9,"end":-1,"scene":"X","dialogue_source":"音轨"}]}',Script)
assert result.shots[0].end == -1
assert result.shots[0].dialogue_source == '音轨'
print('Bundled Python imports creative modules and accepts partial/unrestricted results')
