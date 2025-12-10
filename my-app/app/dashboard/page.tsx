import CameraFeed from "@/components/CameraFeed";

export default function Dashboard() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 font-sans dark:bg-black">
      <div className="flex m-4">
        <h1 className="text-6xl font-bold text-zinc-800 dark:text-zinc-200">
          Dashboard
        </h1>
        <div>
          <p className="text-2xl ml-4 text-zinc-800 dark:text-zinc-200">
            This is where the suite of tools for the lab can live.
          </p>
          <p className="text-xl ml-4 text-zinc-800 dark:text-zinc-200">
            Also a live camera feed --&gt;
          </p>
        </div>
      </div>
      <div>
        <CameraFeed />
      </div>
    </div>
  );
}
