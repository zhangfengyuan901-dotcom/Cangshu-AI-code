"""Display compatibility for model results, not content or consistency validation."""
import json
import math
import re
from typing import get_args, get_origin
from pydantic import BaseModel, Field, model_validator


class DisplayResult(BaseModel):
    @model_validator(mode='before')
    @classmethod
    def display_types(cls, value):
        if not isinstance(value, dict):
            value = {next(iter(cls.model_fields)): value}
        result = {}
        for name, field in cls.model_fields.items():
            item = value.get(name)
            if item is None: continue
            kind = field.annotation
            if kind is str:
                result[name] = item if isinstance(item, str) else json.dumps(item, ensure_ascii=False)
            elif kind is float:
                try:
                    if isinstance(item, str) and ':' in item:
                        number = 0.0
                        for part in item.split(':'): number = number * 60 + float(part)
                    else: number = float(item)
                    result[name] = number if math.isfinite(number) else 0.0
                except (TypeError, ValueError): result[name] = 0.0
            elif get_origin(kind) is list:
                values = item if isinstance(item, list) else [item]
                subtype = get_args(kind)[0]
                result[name] = [str(x) for x in values if x is not None] if subtype is str else values
        return result


class Character(DisplayResult):
    id: str = ''
    name: str = ''
    appearance: str = ''


class Scene(DisplayResult):
    id: str = ''
    description: str = ''


class Relationship(DisplayResult):
    characters: list[str] = Field(default_factory=list)
    description: str = ''
    evidence: str = ''
    certainty: str = ''


class Shot(DisplayResult):
    start: float = 0
    end: float = 0
    characters: list[str] = Field(default_factory=list)
    scene: str = ''
    action: str = ''
    product: str = ''
    emotion: str = ''
    camera: str = ''
    composition: str = ''
    lighting: str = ''
    transition: str = ''
    pacing: str = ''
    screen_text: str = ''
    dialogue: str = ''
    dialogue_source: str = ''
    plot: str = ''
    continuity: str = ''
    confidence: str = ''


class Script(DisplayResult):
    summary: str = ''
    characters: list[Character] = Field(default_factory=list)
    relationships: list[Relationship] = Field(default_factory=list)
    scenes: list[Scene] = Field(default_factory=list)
    shots: list[Shot] = Field(default_factory=list)
    uncertainties: list[str] = Field(default_factory=list)


class DraftShot(DisplayResult):
    start: float = 0
    end: float = 0
    content: str = ''


class Draft(DisplayResult):
    direction: str = ''
    shots: list[DraftShot] = Field(default_factory=list)


def decode_json(text, expected=()):
    value = re.sub(r'^```(?:json)?\s*|\s*```$', '', text.strip())
    expected = set(expected)
    candidates = []
    try:
        candidates.append(json.loads(value))
    except ValueError:
        decoder, cursor = json.JSONDecoder(), 0
        while cursor < len(value):
            starts = [position for position in (value.find('{', cursor), value.find('[', cursor)) if position >= 0]
            if not starts: break
            start = min(starts)
            try:
                candidate, length = decoder.raw_decode(value[start:])
                candidates.append(candidate)
                cursor = start + length
            except ValueError:
                cursor = start + 1
    if expected:
        for candidate in reversed(candidates):
            if isinstance(candidate, dict) and expected.intersection(candidate):
                return candidate
    elif candidates:
        return candidates[-1]
    from pydantic_core import from_json
    for start in reversed([match.start() for match in re.finditer(r'\{', value)]):
        try:
            candidate = from_json(value[start:], allow_partial=True)
            if not expected or (isinstance(candidate, dict) and expected.intersection(candidate)):
                return candidate
        except ValueError:
            continue
    return text


def display_result(raw, schema):
    try:
        value = schema.model_validate(decode_json(raw, schema.model_fields))
        if value.model_dump() != schema().model_dump(): return value
    except (ValueError, TypeError, RecursionError): pass
    # Raw text is also persisted separately by the caller; never invent a script.
    return schema.model_validate({'summary' if schema is Script else 'direction': raw})
