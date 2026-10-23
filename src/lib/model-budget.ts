import { AsyncLocalStorage } from "node:async_hooks";

type ModelBudget = { limit: number; used: number };
const budgets = new AsyncLocalStorage<ModelBudget>();

export function modelRequestBudgetRemaining() {
  const budget = budgets.getStore();
  return budget ? Math.max(0, budget.limit - budget.used) : Infinity;
}
export function consumeModelRequestBudget() {
  const budget = budgets.getStore();
  if (!budget) return;
  if (budget.used >= budget.limit) throw new Error("本轮模型请求预算已用完。");
  budget.used++;
}
export function withModelRequestBudget<T>(limit: number, run: (budget: ModelBudget) => Promise<T>) {
  const budget = { limit, used: 0 };
  return budgets.run(budget, () => run(budget));
}
