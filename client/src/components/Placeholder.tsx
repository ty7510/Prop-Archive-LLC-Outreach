// Shown by pages that a builder has not filled yet.
export default function Placeholder({ title, owner }: { title: string; owner: string }) {
  return (
    <div className="space-y-4">
      <h1>{title}</h1>
      <div className="card">
        <p className="text-lg">This page is being built.</p>
        <p className="mt-1 text-stone-600">Owner: {owner} builder.</p>
      </div>
    </div>
  )
}
