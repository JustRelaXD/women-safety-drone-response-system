import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";

const inputCls = `w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm
  text-slate-900 focus:border-emerald-500 focus:outline-none focus:ring-2
  focus:ring-emerald-500/30 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100`;

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">
        {label}
      </span>
      {children}
      {hint ? (
        <span className="mt-1 block text-[11px] text-slate-500 dark:text-slate-400">
          {hint}
        </span>
      ) : null}
    </label>
  );
}

export function NumberInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} type="number" className={inputCls} />;
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} type="text" className={inputCls} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={inputCls} />;
}
