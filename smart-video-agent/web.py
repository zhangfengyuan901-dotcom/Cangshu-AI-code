"""Start the standalone local Hamster workbench."""
import argparse
import uvicorn
from studio import create_studio

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    uvicorn.run(create_studio(), host="127.0.0.1", port=args.port)
