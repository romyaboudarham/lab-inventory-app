"use client";

import { useRouter } from "next/navigation";

export default function Home() {
  const router = useRouter();

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 font-sans dark:bg-black">
      <div className="flex flex-col items-center gap-6 animate-fadeIn">
        <h1 className="text-4xl font-bold text-zinc-800 dark:text-zinc-200">
          Welcome to Lab
        </h1>
        <button
          onClick={() => router.push("/dashboard")}
          className="px-6 py-3 bg-gray-600 text-white rounded-lg hover:bg-gray-400 transition-colors"
        >
          Continue
        </button>
      </div>
    </div>
  );
}
