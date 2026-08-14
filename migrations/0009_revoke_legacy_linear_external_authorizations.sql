UPDATE linear_connection_context
SET status = 'revoked',
    access_token_ciphertext = '',
    refresh_token_ciphertext = '',
    refresh_claim_until = NULL,
    updated_at = cast(unixepoch('subsecond') * 1000 as integer)
WHERE broker_reference LIKE 'linear:%'
  AND status = 'active';

UPDATE linear_connection_binding
SET status = 'revoked',
    updated_at = cast(unixepoch('subsecond') * 1000 as integer)
WHERE broker_reference LIKE 'linear:%'
  AND status = 'active';
