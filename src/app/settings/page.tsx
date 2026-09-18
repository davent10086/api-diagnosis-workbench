import { Shell, Top } from "@/components/app-shell";

export default function SettingsPage() {
  const databaseConfigured = Boolean(process.env.DATABASE_URL);
  return (
    <Shell>
      <Top title="设置" />
      <div className="page">
        <h1 className="page-title">本地设置</h1>
        <div className="mt-5 border-y border-slate-200 bg-white divide-y divide-slate-200">
          <div className="px-4 py-3">
            <b>数据存储</b>
            <p className="mt-2 text-sm text-muted">
              PostgreSQL：{databaseConfigured ? "已配置" : "未配置"}；附件保存在项目 storage/ 目录。
            </p>
          </div>
          <div className="px-4 py-3">
            <b>数据处理</b>
            <p className="mt-2 text-sm text-muted">
              当前版本使用确定性规则。JSON 和 TXT 会在服务端脱敏；图片需要人工确认已脱敏。
            </p>
          </div>
        </div>
      </div>
    </Shell>
  );
}
