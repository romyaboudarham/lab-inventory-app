"use client"

import { useEffect, useRef } from "react";
import Image from 'next/image'
import searchLogo from '/images/search-svgrepo-com.svg'

const SearchBar = () => {
    return(
        <div className="relative w-full text-gray-600">
                <Image
                    className="absolute left-0 top-0 mt-3 ml-4 h-4 w-4"
                    src="/images/search-svgrepo-com.svg"
                    alt="Search"
                    width={16}
                    height={16}
                />
            <input
                className="bg-pink h-10 pl-10 px-5 pr-10 w-full rounded-full text-sm outline-1 focus:outline-amber-300"
                type="search"
                name="search"
            />
        </div>
    );
};

export default SearchBar;
