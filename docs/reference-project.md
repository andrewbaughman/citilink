This is an attempt to make a useful tool out of the data publicly available about the bus system in Fort Wayne. 

I found an REST API, which I've used Claude to document in the folder /api-discovery.
I also had Claude make a simple tool to showcase the use of that API with vanilla JavaScript, located in /poc.
I also had Claude make a simple webapp as an initial GUI with basic features, located in /webapp.

Before I commit to any large effort like a mobile app, I want to ensure I can make a quality webapp. Webapps are easier to get off the ground.

What I want in the web app:
- simple layout: map canvas with zoom and pan, side panel (right or left, I don't care) with info that isn't map centric (list data, alerts, etc.)
- highlighted routes on the map
- buses clearly shown on the map, same color as route, easily identifiable shape (for example, a bus)
- icons showing bus stops
- when user clicks on something, the interface adjusts to show the relevant info
    - click on bus or route, show the route, buses on that route, and info about the route in the side panel
- when a user clicks on the bus stop
    - show the upcoming buses & times that will stop there, and routes
    - show typical wait between buses stopping there

Notes:
- The data about when the bus will show up might be wrong. I wonder if it's based on different routes. Perhaps I could come up with the predictions myself based on the tracking data.


The key problems I want to solve with this are accessibility and accuracy. Where's my bus?