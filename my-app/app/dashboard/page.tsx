import CameraFeed from "@/components/CameraFeed";
import SearchBar from "@/components/SearchBar";
import ItemCard from "@/components/ItemCard";
import { itemCardById } from "@/data/itemCardIndex"
import MotionDetectionCamera from "@/components/MotionDetectionCamera";

export default function Dashboard() {
  return (
    <div className="min-h-screen bg-zinc-50 font-sans dark:bg-black flex flex-col items-center p-4">

      {/* Dashboard moved to top */}
      <h1 className="text-6xl font-bold text-zinc-800 dark:text-zinc-200 mb-8">
        Dashboard
      </h1>

      {/* Original row layout */}
      <div className="flex flex-col md:flex-row items-start md:items-center">
        <div className="w-full md:w-auto mt-4 md:mt-0">
          {/* <CameraFeed /> */}
          <MotionDetectionCamera />
        </div>

        <div className="md:ml-6 flex flex-col items-center">
          <div className="w-full max-w-sm mb-4">
            <SearchBar />
          </div>
  
          {/* TODO: 
          - default: display all item cards
          - OnSearch: filter item cards */}
          <div className="flex flex-row flex-wrap gap-4 justify-center">
            <ItemCard itemCard= {itemCardById["arduino-uno-r3"]}/>
            <ItemCard itemCard= {itemCardById["arduino-leonardo"]}/>
          </div>
        </div>
      </div>

    </div>
  );
}
