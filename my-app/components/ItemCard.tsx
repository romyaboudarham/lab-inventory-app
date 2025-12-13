"use client"

import Image from 'next/image'
import type { ItemCard } from "@/types/ItemCard"

type ItemCardProps = {
    itemCard: ItemCard
}

export default function ItemCard({ itemCard }: ItemCardProps) {

    return (
        <div className="w-[15rem] items-center rounded-[1rem] border-1 shadow-[0_10px_8px_#999] flex flex-col m-[.5rem] bg-white">
            <div className="relative w-full h-[180px] overflow-hidden rounded-[1rem_1rem_0_0]">
                <Image 
                    src={itemCard.image} 
                    alt={itemCard.name} 
                    fill
                    className="object-cover"
                    sizes="(max-width: 768px) 100vw, 240px"
                />
            </div>
            <h2 className="mb-[0.5rem] mx-[5%]">{itemCard.name}</h2>
            <p className="my-[0.5rem] mx-[5%] h-[8rem] overflow-y-auto text-sm leading-snug pr-1">
                {itemCard.description}
            </p>
            <a
                href={itemCard.productLink}
                target="_blank"
                rel="noopener noreferrer"
                className="block self-stretch my-[0.5rem] mx-[5%] px-[0.5rem] py-[0.2rem] text-center bg-gray-600 text-white rounded-lg hover:bg-gray-400 transition-colors"
            >
                Product Link
            </a>
        </div>
    );
}