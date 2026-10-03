"""Download the pinned public Julia runtime/checkpoint into the current workspace."""
import os
import hashlib
from pathlib import Path

os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
os.environ["HF_HUB_DISABLE_PROGRESS_BARS"] = "1"
from huggingface_hub import snapshot_download

REVISION = "a85b127321d580d65176c89ced8273f305745d85"
target = Path(".julia-model")
snapshot_download("SupersonicLabs/Julia-1", revision=REVISION, local_dir=str(target), token=False)
with (target / "model.safetensors").open("rb") as weights:
    if hashlib.file_digest(weights, "sha256").hexdigest() != "df853bf7fe424420011f3d0c47a05d7341aa9eefa7fb9f203ea4aada4ad95b72":
        raise RuntimeError("Downloaded weights do not match the pinned checkpoint SHA-256.")
(target / ".jevmap-revision").write_text(REVISION + "\n", encoding="utf-8")
print(f"Downloaded Julia 1 revision {REVISION} to {target.resolve()}")
