import React from 'react';

export default function SignSpeakLoginBackground() {
  return (
    <>
      <div className="login-background-circle login-circle-a" aria-hidden="true" />
      <div className="login-background-circle login-circle-b" aria-hidden="true" />
      <div className="login-background-circle login-circle-c" aria-hidden="true" />
      {Array.from({ length: 12 }, (_, index) => (
        <span
          key={index}
          className={`login-dot login-dot-${index + 1}`}
          aria-hidden="true"
        />
      ))}
    </>
  );
}
