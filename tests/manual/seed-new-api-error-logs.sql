-- Local-only synthetic error logs for testing Request ID import.
WITH examples(request_id, model_name, content, upstream_request_id, use_time) AS (
  VALUES
    ('demo-err-400-invalid-parameter', 'claude-3-7-sonnet', 'HTTP 400 | invalid_request_error | max_tokens must be greater than 0; request rejected before contacting upstream.', '', 0),
    ('demo-err-429-rate-limit', 'gpt-4o-mini', 'HTTP 429 | rate_limit_exceeded | upstream requests per minute exceeded; retry after 30 seconds.', 'upstream-demo-429', 2),
    ('demo-err-502-upstream-reset', 'gemini-2.5-pro', 'HTTP 502 | bad_gateway | upstream connection reset while reading the response headers.', 'upstream-demo-502', 4),
    ('demo-err-504-timeout', 'claude-sonnet-4', 'HTTP 504 | gateway_timeout | upstream response deadline exceeded after 60 seconds.', 'upstream-demo-504', 60)
)
INSERT INTO logs (user_id, created_at, type, content, username, token_name, model_name, quota, prompt_tokens, completion_tokens, use_time, is_stream, channel_id, token_id, "group", ip, request_id, upstream_request_id, other)
SELECT 1, EXTRACT(EPOCH FROM NOW())::bigint, 5, e.content, 'local-demo', 'local-demo', e.model_name, 0, 0, 0, e.use_time, false, 0, 0, 'default', '', e.request_id, e.upstream_request_id, '{}'
FROM examples e
WHERE NOT EXISTS (SELECT 1 FROM logs l WHERE l.request_id = e.request_id);
