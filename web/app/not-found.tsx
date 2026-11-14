import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="panel mx-auto mt-10 max-w-md p-6 text-center">
      <h1 className="text-2xl font-bold">Nothing at this address</h1>
      <p className="mt-2 text-muted">The item may have sold, or the link is mistyped.</p>
      <Link className="btn btn-primary mt-5" href="/">Search listings</Link>
    </div>
  );
}
