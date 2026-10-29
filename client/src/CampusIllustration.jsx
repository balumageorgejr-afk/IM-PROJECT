import React from "react";

// Decorative, local vector artwork: no external assets or tracking requests.
export default function CampusIllustration() {
    return (
        <svg
            className="campus-illustration"
            viewBox="0 0 520 200"
            fill="none"
            aria-hidden="true"
            focusable="false"
        >
            <path d="M16 182H504" stroke="currentColor" />
            <path
                d="M124 182V78L260 24L396 78V182"
                fill="#242424"
                stroke="currentColor"
            />
            <path
                d="M108 80L260 18L412 80H108Z"
                fill="#343434"
                stroke="currentColor"
            />
            <path d="M144 94H376M144 158H376" stroke="#888888" />
            {[162, 214, 286, 338].map((x) => (
                <g key={x}>
                    <path
                        d={`M${x} 104H${x + 20}V148H${x}Z`}
                        fill="#444444"
                        stroke="#aaaaaa"
                    />
                    <path
                        d={`M${x + 10} 104V148M${x} 126H${x + 20}`}
                        stroke="#aaaaaa"
                    />
                </g>
            ))}
            <path
                d="M242 182V112A18 18 0 0 1 278 112V182M260 112V182"
                stroke="currentColor"
            />
            <path
                d="M60 182V130M50 142L60 152L74 135M448 182V126M436 138L448 150L460 136"
                stroke="#aaaaaa"
            />
            <circle cx="60" cy="118" r="28" fill="#343434" stroke="#888888" />
            <circle cx="448" cy="114" r="30" fill="#343434" stroke="#888888" />
            <circle cx="260" cy="58" r="12" stroke="currentColor" />
            <path d="M260 50V58L266 62M226 190H294" stroke="currentColor" />
        </svg>
    );
}
