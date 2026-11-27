import React from 'react';

export default function SignSpeakFlowers() {
  return (
    <svg
      className="login-flower-art"
      viewBox="0 0 420 300"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="Colorful flowers growing in pastel flower pots"
    >
      <defs>
        <linearGradient id="flower-leaf" x1="0" y1="0" x2="1" y2="1">
          <stop stopColor="#a5e0d2" />
          <stop offset="1" stopColor="#397f7c" />
        </linearGradient>
        <linearGradient id="flower-pot" x1="0" y1="0" x2="0" y2="1">
          <stop stopColor="#f9b5c8" />
          <stop offset="1" stopColor="#dc8da9" />
        </linearGradient>
      </defs>

      <path d="M205 245 C150 170 95 125 40 112 C94 176 123 219 180 251Z" fill="url(#flower-leaf)" />
      <path d="M230 245 C240 142 260 68 315 30 C300 113 281 190 251 250Z" fill="#8fcfc1" />
      <path d="M248 245 C276 156 330 126 375 130 C330 169 300 215 263 255Z" fill="#78b8a9" />
      <path d="M178 247 C152 176 165 100 190 66 C207 133 209 191 199 250Z" fill="#4f8582" />
      <path d="M280 246 C290 190 325 170 357 175 C331 204 315 228 293 253Z" fill="#4e9b91" />

      <g fill="none" stroke="#3e8178" strokeLinecap="round" strokeWidth="7">
        <path d="M184 230 Q170 138 137 90" />
        <path d="M225 235 Q218 105 220 50" />
        <path d="M266 237 Q293 120 330 80" />
        <path d="M140 240 Q120 170 88 150" />
      </g>

      <g transform="translate(220 45)" fill="#f7a9c0">
        <ellipse cy="-17" rx="9" ry="17" />
        <ellipse cy="-17" rx="9" ry="17" transform="rotate(45)" />
        <ellipse cy="-17" rx="9" ry="17" transform="rotate(90)" />
        <ellipse cy="-17" rx="9" ry="17" transform="rotate(135)" />
        <ellipse cy="-17" rx="9" ry="17" transform="rotate(180)" />
        <ellipse cy="-17" rx="9" ry="17" transform="rotate(225)" />
        <ellipse cy="-17" rx="9" ry="17" transform="rotate(270)" />
        <ellipse cy="-17" rx="9" ry="17" transform="rotate(315)" />
        <circle r="10" fill="#f5d17c" />
      </g>

      <g transform="translate(330 105)" fill="#f6a5b9">
        <ellipse cy="-12" rx="8" ry="13" />
        <ellipse cy="-12" rx="8" ry="13" transform="rotate(60)" />
        <ellipse cy="-12" rx="8" ry="13" transform="rotate(120)" />
        <ellipse cy="-12" rx="8" ry="13" transform="rotate(180)" />
        <ellipse cy="-12" rx="8" ry="13" transform="rotate(240)" />
        <ellipse cy="-12" rx="8" ry="13" transform="rotate(300)" />
        <circle r="7" fill="#f5d17c" />
      </g>

      <g fill="#f7b2c5">
        <circle cx="78" cy="143" r="12" />
        <circle cx="78" cy="143" r="5" fill="#f7d37d" />
        <circle cx="115" cy="89" r="7" />
        <circle cx="115" cy="89" r="3" fill="#f7d37d" />
      </g>

      <path d="M105 116 Q101 106 113 102 L157 102 Q169 106 164 119 L151 159 Q135 173 119 158Z" fill="url(#flower-pot)" />
      <path d="M105 113 Q135 123 164 113" fill="none" stroke="#fbd3dc" strokeWidth="5" />
      <path d="M170 225 Q155 195 169 177 Q188 158 212 180 L245 242Z" fill="#f3a2b8" />
      <path d="M45 240 Q42 215 62 207 Q89 196 112 221 L130 248Z" fill="#6f617f" />
      <path d="M258 244 Q264 215 292 211 Q320 208 334 240Z" fill="#71647e" />
      <path d="M90 246 Q107 227 137 235 Q157 240 170 254 L104 258Z" fill="#f5abc2" />
      <path d="M282 250 Q307 228 340 240 Q356 246 365 258 L294 261Z" fill="#f5abc2" />
      <path
        d="M20 255 Q85 244 155 255 Q225 268 300 255 Q355 248 400 258"
        fill="none"
        stroke="#e9a5bc"
        strokeLinecap="round"
        strokeWidth="8"
      />
      <circle cx="25" cy="225" r="14" fill="#f6c56d" />
      <circle cx="25" cy="225" r="7" fill="#ffd98b" />
      <circle cx="385" cy="226" r="13" fill="#f6c56d" />
      <circle cx="150" cy="72" r="15" fill="#f4a9be" />
    </svg>
  );
}
