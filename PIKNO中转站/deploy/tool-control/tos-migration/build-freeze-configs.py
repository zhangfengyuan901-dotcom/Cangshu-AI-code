"""Build version-upload configurations for the temporary R2 write fence."""
import argparse
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
SOURCES = {
    "pikno": ROOT / "cloudflare/relay-media",
    "legacy-media": ROOT / "仓鼠AI/cloudflare/media-worker",
    "legacy-billing": ROOT / "仓鼠AI/cloudflare/billing-worker",
}


def freeze_config(label: str, folder: Path) -> dict:
    baseline = folder / "tos-migration/wrangler.r2-baseline.jsonc"
    config = json.loads(baseline.read_text(encoding="utf-8-sig"))
    if not config.get("r2_buckets"):
        raise ValueError("Frozen R2 baseline required")
    config.pop("$schema", None)
    config["main"] = (folder / "tos-migration/freeze.mjs").as_posix()
    if label == "pikno":
        # Cloudflare's active routes include the custom domain tested separately
        # from the historical www route in the maintained wrapper config.
        config["routes"].append({"pattern": "media.piknoai.com", "custom_domain": True})
        config["vars"]["CONTROL_OWNER"] = "blocked"
    if "assets" in config:
        config["assets"]["directory"] = (folder / config["assets"]["directory"]).resolve().as_posix()
    for binding in config.get("d1_databases", []):
        binding["migrations_dir"] = (folder / binding["migrations_dir"]).resolve().as_posix()
    return config


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    for label, folder in SOURCES.items():
        with (args.output / (label + ".json")).open("x", encoding="utf8") as output:
            json.dump(freeze_config(label, folder), output, indent=2, ensure_ascii=False)
            output.write("\n")


if __name__ == "__main__":
    main()
