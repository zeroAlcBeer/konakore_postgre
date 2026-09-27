-- Migration 007: remove the aria2 RPC token from stored aria_log records
--
-- Before commit b858b76, sendAria2Request logged its params after
-- prepending the "token:<secret>" RPC argument, so the aria2 secret was
-- stored in plain text as params[0]. Nothing reads aria_log; drop that
-- element and keep the rest of the record.

UPDATE file_sync
SET aria_log = aria_log #- '{params,0}'
WHERE jsonb_typeof(aria_log -> 'params') = 'array'
  AND aria_log -> 'params' ->> 0 LIKE 'token:%';
