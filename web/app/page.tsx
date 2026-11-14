import { SearchExperience } from '@/components/SearchExperience';
import { placeNames } from '@/lib/logic/geo';

export default function Home() {
  return <SearchExperience places={placeNames()} />;
}
