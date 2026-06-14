-- Demo upload for the Mangalore routing map.
-- Use the app's Import SQL button to add or update these markers.

INSERT INTO mangalore.locations (
  name,
  location_type,
  address,
  latitude,
  longitude,
  place_query
) VALUES
  ('Demo Central Depot', 'DEPOT', 'State Bank, Mangaluru', 12.8692500, 74.8425800, 'State Bank Mangaluru'),
  ('Demo Kadri Apartments', 'CUSTOMER', 'Kadri Park Road', 12.8958600, 74.8535900, 'Kadri Park Mangaluru'),
  ('Demo Kankanady Market', 'CUSTOMER', 'Kankanady Market', 12.8720600, 74.8589200, 'Kankanady Mangaluru'),
  ('Demo Bejai Collection Point', 'CUSTOMER', 'Bejai Main Road', 12.8977600, 74.8418900, 'Bejai Mangaluru'),
  ('Demo Jeppu Recycling Vendor', 'VENDOR', 'Jeppu Market Road', 12.8546400, 74.8520400, 'Jeppu Mangaluru'),
  ('Demo Panambur Truck Stop', 'TRUCK_STOP', 'Panambur, Mangaluru', 12.9459200, 74.8046200, 'Panambur Mangaluru')
ON CONFLICT (name) DO UPDATE
SET
  location_type = EXCLUDED.location_type,
  address = EXCLUDED.address,
  latitude = EXCLUDED.latitude,
  longitude = EXCLUDED.longitude,
  place_query = EXCLUDED.place_query;
