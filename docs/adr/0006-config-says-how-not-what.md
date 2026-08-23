# Configuration says how to read the source, never what is in it

The config file maps labels to states and names the Notion columns to
write. It may not supply due dates, descriptions or progress. Those come
from GitLab or they are absent and reported as absent.

## Consequences

A config that carries project content is a second roadmap in TOML —
maintained by hand, drifting, exactly what this tool exists to remove.
The temptation is real: when a project lacks structure, filling the gap
from a file looks helpful and quietly defeats the purpose.

Credentials live in the environment (`GITLAB_TOKEN`, `NOTION_TOKEN`),
never in the file, so the config can be shared or committed by its owner.
