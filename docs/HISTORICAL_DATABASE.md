# 历史日志库接入与查询

本指南用于将 MySQL 格式的 new-api 历史日志备份接入本地排障环境。备份文件名或目录名不代表实际覆盖月份，应以恢复后 `created_at` 的时间边界为准。

## 接入方式

保留当前 new-api 主库及登录配置，将备份中的 `logs` 表恢复到独立的 MySQL 8.4 数据库 `new_api_history`。通过 new-api 的 `LOG_SQL_DSN` 指向历史库，排障工具继续通过 new-api 日志接口查询。

原始备份只读打开，不恢复历史账号、令牌、渠道密钥和系统配置。历史查询实例不用于转发新请求。MySQL 可以仅监听本机地址；Docker Desktop 环境可验证通过 `host.docker.internal` 访问本机服务。

## 准备数据库

先安装 [MySQL 8.4](https://dev.mysql.com/downloads/mysql/8.4.html)，在独立实例中创建空库：

```sql
CREATE DATABASE new_api_history CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
```

将管理凭据写入仓库外的私有 MySQL 客户端配置，例如 `D:\history\root-client.ini`。限制文件访问权限，不提交到 GitHub。

```ini
[client]
user=root
password=REPLACE_WITH_PRIVATE_PASSWORD
host=127.0.0.1
port=13308
```

## 恢复日志

在本仓库根目录执行，替换为自己的文件路径：

```powershell
python scripts/restore-history-logs.py 'D:\backups\new-api-backup.sql' --mysql-client 'D:\mysql\bin\mysql.exe' --defaults-file 'D:\history\root-client.ini' --manifest 'D:\history\restore-manifest.json'
```

也支持 Docker 中已启动的 MySQL 实例，容器内应已创建空库 `new_api_history` 并配置 `MYSQL_ROOT_PASSWORD`：

```powershell
python scripts/restore-history-logs.py 'D:\backups\new-api-backup.sql' --container new-api-history-mysql --manifest 'D:\history\restore-manifest.json'
```

脚本已有 `logs` 表时拒绝覆盖。脚本针对可信的标准 mysqldump，只提取 `CREATE TABLE logs` 和单行 `INSERT INTO logs VALUES`，不会执行备份中的全局 GTID 设置及其他表语句；不支持任意 SQL 备份格式，也不是不可信 SQL 的执行沙箱。

导入后建立账号与时间、请求 ID、上游请求 ID、时间与日志类型索引。清单记录总行数、时间边界、错误日志数量和缺失请求 ID 的数量。索引完成前，大库查询可能超时。导入失败会留下部分恢复的独立库，脚本不会自动删除或覆盖它，应由操作人员核查后处理。

## 配置 new-api

为历史查询创建专用账号，对历史日志只开放读取权限：

```sql
CREATE USER 'archive_reader'@'%' IDENTIFIED BY 'REPLACE_WITH_PRIVATE_PASSWORD';
GRANT SELECT ON new_api_history.* TO 'archive_reader'@'%';
```

按部署环境限制数据库监听地址、访问来源和账号 Host。new-api 的历史查询实例使用如下环境变量；密码从私有环境文件注入：

```dotenv
LOG_SQL_DSN=archive_reader:REPLACE_WITH_PRIVATE_PASSWORD@tcp(host.docker.internal:13308)/new_api_history?charset=utf8mb4&parseTime=True&loc=Local
NODE_TYPE=slave
```

历史查询模式通过 `NODE_TYPE=slave` 跳过日志库自动迁移。保留原有主库 `SQL_DSN`。如果当前 new-api 版本会向日志库写入 `audit_logs`，应由管理员按该部署版本的审计模型单独建立空审计表，仅额外授予该表 `INSERT` 权限；历史 `logs` 表仍保持只读。不要将历史账号或渠道密钥恢复到主库以解决查询问题。

排障工具的 `.env.local` 设置：

```dotenv
NEW_API_BASE_URL=http://127.0.0.1:3000
NEW_API_ACCESS_TOKEN=REPLACE_WITH_PRIVATE_LOG_ACCESS_TOKEN
```

启动排障工具后，先验证日志接口权限，再用真实但仅保存在本地的请求标识验证导入和按账号查询。切回原日志库时，从 new-api 的部署配置移除 `LOG_SQL_DSN` 并恢复原有节点配置，重启实例；原主库及其原日志保持保留。

## 查询与证据边界

- 新建案件时填写已核实的客户账号和历史日期，再补充模型、渠道或错误关键词。无可解析时间时默认查询近期，不会猜测备份月份。
- 有 Request ID 时可直接导入；时间不准时使用请求定位，核对候选后再导入。
- 案件详情中的自主助手可以根据问题选择查询日志和执行规则；账号未确认时，不开放日志工具。
- 旧日志可能省略空的 `request_id` 字段。解析器允许整页正常读取，但没有请求标识的记录不会被伪造 ID 或作为按请求 ID 导入的候选。
- new-api 可能从当前主库补充渠道名称，名称可能为空或与历史不同。应核对历史渠道编号和当时配置，不能用当前主库推断历史状态。
- 同一请求可能包含错误和消耗等多个事件。错误行数不等于去重失败请求数，消耗记录也不能单独证明最终业务成功。需要结合时间、渠道、上游请求标识和重试链路判断。

实际日志、恢复清单、客户账号、请求标识和本地分析结果只保存在部署环境，不属于本仓库。自主对话不自动写入正式诊断历史，根因仍需人工核对。
