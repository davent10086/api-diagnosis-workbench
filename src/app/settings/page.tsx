import { Top } from "@/components/app-shell";

export default function SettingsPage() {
  const databaseConfigured = Boolean(process.env.DATABASE_URL);
  return (
    <>
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
              JSON 和 TXT 会在服务端脱敏；上传的图片保留原图并可直接用于诊断识别。
            </p>
          </div>
        </div>
      </div>
    </>
  );
}
