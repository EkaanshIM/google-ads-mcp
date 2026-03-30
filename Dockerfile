FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV PORT=8080
ENV HOST=0.0.0.0
ENV MCP_PATH=/mcp

WORKDIR /app

COPY . /app

RUN pip install --no-cache-dir .

EXPOSE 8080

CMD ["google-ads-mcp-cloud-run"]
