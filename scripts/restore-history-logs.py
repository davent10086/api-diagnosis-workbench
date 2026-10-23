"""Restore only the logs table from a mysqldump into an empty local archive.

The source is opened read-only. Accounts, tokens, channels and executable dump
directives are never restored. Credentials come from a private client config
or the database container environment.
"""
import argparse
import json
import re
import subprocess
import time
from pathlib import Path


def client(container, sql=None, native_client=None, defaults_file=None):
    command = ([str(native_client), "--defaults-extra-file=" + str(defaults_file),
                "--default-character-set=utf8mb4", "--max-allowed-packet=256M",
                "--batch", "--skip-column-names", "new_api_history"] if native_client else
               ["docker", "exec", "-i", container, "sh", "-c",
               'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql -uroot '
               '--default-character-set=utf8mb4 --max-allowed-packet=256M '
               '--batch --skip-column-names new_api_history'])
    if sql is None:
        return subprocess.Popen(command, stdin=subprocess.PIPE, stderr=subprocess.PIPE)
    result = subprocess.run(command, input=sql.encode(), capture_output=True, check=True)
    return result.stdout.decode().strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dump", type=Path)
    parser.add_argument("--container", default="new-api-history-mysql")
    parser.add_argument("--mysql-client", type=Path)
    parser.add_argument("--defaults-file", type=Path)
    parser.add_argument("--manifest", type=Path, required=True)
    args = parser.parse_args()
    if bool(args.mysql_client) != bool(args.defaults_file):
        parser.error("--mysql-client and --defaults-file must be supplied together")
    def db(sql=None):
        return client(args.container, sql, args.mysql_client, args.defaults_file)
    if db("SHOW TABLES LIKE 'logs';"):
        raise SystemExit("Refusing to overwrite an existing logs table. Use an empty archive database.")
    started = time.monotonic()
    count = 0
    read_bytes = 0
    next_progress = 256 * 1024 * 1024
    process = db()
    try:
        process.stdin.write(b"SET NAMES utf8mb4; SET SESSION sql_mode='NO_AUTO_VALUE_ON_ZERO';\n")
        with args.dump.open("rb") as source:
            schema = None
            for line in source:
                read_bytes += len(line)
                if line.startswith(b"CREATE TABLE `logs` ("):
                    schema = [line]
                    continue
                if schema is not None:
                    # Build the archive's query indexes after loading; this avoids
                    # maintaining unrelated legacy indexes for every inserted row.
                    if not re.match(rb"\s*(?:UNIQUE )?KEY ", line):
                        schema.append(line)
                    if line.startswith(b") ENGINE="):
                        statement = b"".join(schema)
                        statement = re.sub(rb",\n(?=\) ENGINE=)", b"\n", statement)
                        process.stdin.write(statement)
                        schema = None
                    continue
                if line.startswith(b"INSERT INTO `logs` VALUES "):
                    if not line.rstrip().endswith(b";"):
                        raise RuntimeError("Unsupported multiline INSERT; import stopped.")
                    process.stdin.write(line)
                    count += 1
                if read_bytes >= next_progress:
                    print(json.dumps({"phase": "restore", "readGiB": round(read_bytes / 2**30, 2),
                                      "insertBatches": count, "seconds": round(time.monotonic()-started)}), flush=True)
                    next_progress = read_bytes + 256 * 1024 * 1024
        if not count:
            raise RuntimeError("No log INSERT statements found.")
        process.stdin.close()
        error = process.stderr.read().decode(errors="replace")
        if process.wait() != 0:
            raise RuntimeError("MySQL import failed: " + error[:1000])
    except BaseException:
        process.kill()
        process.wait()
        raise
    print(json.dumps({"phase": "index", "insertBatches": count}), flush=True)
    db("""
      ALTER TABLE logs
        ADD INDEX idx_archive_username_time (username, created_at, id),
        ADD INDEX idx_logs_request_id (request_id),
        ADD INDEX idx_logs_upstream_request_id (upstream_request_id),
        ADD INDEX idx_created_at_type (created_at, type);
      ANALYZE TABLE logs;
    """)
    statistics = db("""
      SELECT COUNT(*), MIN(created_at), MAX(created_at),
             SUM(type=5), SUM(request_id IS NULL OR request_id='') FROM logs;
    """).split("\t")
    manifest = {"source": str(args.dump.resolve()), "sourceBytes": args.dump.stat().st_size,
                "backend": "native" if args.mysql_client else "docker",
                "database": "new_api_history", "table": "logs",
                "rows": int(statistics[0]), "minTimestamp": int(statistics[1]),
                "maxTimestamp": int(statistics[2]), "errorRows": int(statistics[3]),
                "missingRequestIdRows": int(statistics[4]),
                "seconds": round(time.monotonic()-started), "sourceModified": False}
    args.manifest.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(manifest, ensure_ascii=True), flush=True)


if __name__ == "__main__":
    main()
