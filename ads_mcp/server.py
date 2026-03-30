# Copyright 2026 Google LLC.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#      http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Entry points for the MCP server."""

import os

from starlette.requests import Request
from starlette.responses import JSONResponse

from ads_mcp.coordinator import mcp

# The following imports are necessary to register the tools with the `mcp`
# object, even though they are not directly used in this file.
# The `# noqa: F401` comment tells the linter to ignore the "unused import"
# warning.
from ads_mcp.tools import search, core, get_resource_metadata  # noqa: F401
from ads_mcp.resources import (
    discovery,
    metrics,
    release_notes,
    segments,
)  # noqa: F401


@mcp.custom_route("/healthz", methods=["GET"], include_in_schema=False)
async def health_check(_: Request) -> JSONResponse:
    return JSONResponse(
        {
            "status": "ok",
            "transport": "streamable-http",
            "mcp_path": mcp.settings.streamable_http_path,
        }
    )


def run_server() -> None:
    mcp.run()


def run_cloud_run_server() -> None:
    mcp.settings.host = os.environ.get("HOST", "0.0.0.0")
    mcp.settings.port = int(os.environ.get("PORT", "8080"))
    mcp.settings.streamable_http_path = os.environ.get("MCP_PATH", "/mcp")
    mcp.settings.json_response = True
    mcp.settings.stateless_http = True
    mcp.run(transport="streamable-http")


if __name__ == "__main__":
    run_server()
