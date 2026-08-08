UPDATE github_connection_binding
SET scopes_json = replace(scopes_json, '"github:', '"')
WHERE scopes_json LIKE '%"github:%';

DROP TABLE idempotency_response;
