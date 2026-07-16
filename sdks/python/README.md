# Lite-Harness Python SDK

This is a dependency-free alpha client for Lite-Harness REST and replayable
SSE. Package publication remains disabled until the public product name is
resolved.

```python
from lite_harness import LiteHarnessClient

client = LiteHarnessClient("http://127.0.0.1:3210", "app-token")
created = client.create_run(agent="coder", workspace="demo", input="Create hello.txt")
for event in client.events(created["runId"]):
    print(event["sequence"], event["type"])
```
