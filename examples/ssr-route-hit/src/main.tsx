import React from "react";
import { createRoot } from "react-dom/client";

function App() {
  return (
    <main>
      <h1>SSR Route-Hit Example</h1>
      <p>Open <code>/ssr</code> to hit backend-rendered HTML.</p>
      <p>Open <code>/api/user/42</code> to hit backend JSON route.</p>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
