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

"""Module declaring the singleton MCP instance.

The singleton allows other modules to register their tools with the same MCP
server using `@mcp.tool` annotations, thereby 'coordinating' the bootstrapping
of the server.
"""

import os

from mcp.server.fastmcp import FastMCP


def _env_flag(name: str, default: bool) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.lower() in {"1", "true", "yes", "on"}


mcp = FastMCP(
    "Google Ads Server",
    host=os.environ.get("HOST", "127.0.0.1"),
    port=int(os.environ.get("PORT", "8000")),
    streamable_http_path=os.environ.get("MCP_PATH", "/mcp"),
    json_response=_env_flag("MCP_JSON_RESPONSE", True),
    stateless_http=_env_flag("MCP_STATELESS_HTTP", True),
)
